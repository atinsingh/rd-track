import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

/** A key and self-signed certificate, made with openssl so no key is kept in the repository. */
export function makeSigner(name: string): { key: string; cert: string; certB64: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rd-saml-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '30', '-subj', `/CN=${name}`], { stdio: 'ignore' });
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert, certB64: cert.replace(/-----[^-]+-----|\s/g, '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Answer {
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string>;
  /** Override what the answer says. */
  audience?: string;
  issuer?: string;
  inResponseTo?: string;
  /** Sign with this key instead (an attacker's). */
  signWith?: string;
  /** Leave the assertion unsigned. */
  unsigned?: boolean;
  /** Answer with a failure status and no assertion. */
  status?: string;
}

/**
 * A SAML 2.0 identity provider for tests: publishes metadata, reads the AuthnRequest out of
 * the redirect URL, and writes signed Responses (assertion signed, as most providers do).
 */
export class FakeSamlIdp {
  entityId = 'https://idp.example.test/saml';
  ssoUrl = 'https://idp.example.test/sso';
  readonly signer = makeSigner('idp.example.test');

  metadata(certB64 = this.signer.certB64) {
    return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${this.entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIBOGUS</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
${certB64.match(/.{1,64}/g)!.join('\n')}
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${this.ssoUrl}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${this.ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
  }

  /** What Track asked for: the request's ID, who it's from, where to answer, and the RelayState. */
  read(redirectUrl: string) {
    const u = new URL(redirectUrl);
    const xml = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    return {
      url: `${u.origin}${u.pathname}`,
      id: /\sID="([^"]+)"/.exec(xml)![1]!,
      issuer: /<saml:Issuer[^>]*>([^<]+)</.exec(xml)![1]!,
      acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)![1]!,
      relayState: u.searchParams.get('RelayState')!,
      xml,
    };
  }

  /** A base64 SAMLResponse to Track's request in `redirectUrl`. */
  answer(redirectUrl: string, a: Answer): { samlResponse: string; relayState: string; acs: string } {
    const req = this.read(redirectUrl);
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const irt = a.inResponseTo ?? req.id;
    const issuer = a.issuer ?? this.entityId;
    const attrs = Object.entries(a.attributes ?? {})
      .map(([k, v]) => `<saml:Attribute Name="${k}"><saml:AttributeValue>${v}</saml:AttributeValue></saml:Attribute>`)
      .join('');
    const assertion = a.status
      ? ''
      : `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${now}${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${at(0)}">` +
        `<saml:Issuer>${issuer}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="${a.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'}">${a.nameId}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${irt}" NotOnOrAfter="${at(300_000)}" Recipient="${req.acs}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${at(-30_000)}" NotOnOrAfter="${at(300_000)}"><saml:AudienceRestriction><saml:Audience>${a.audience ?? req.issuer}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
        `</saml:Assertion>`;
    const status = `<samlp:Status><samlp:StatusCode Value="${a.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>`;
    let xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${now}" Version="2.0" IssueInstant="${at(0)}" Destination="${req.acs}" InResponseTo="${irt}">` +
      `<saml:Issuer>${issuer}</saml:Issuer>${status}${assertion}</samlp:Response>`;
    if (assertion && !a.unsigned) {
      const sig = new SignedXml({
        privateKey: a.signWith ?? this.signer.key,
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      });
      sig.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
      sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      xml = sig.getSignedXml();
    }
    return { samlResponse: Buffer.from(xml).toString('base64'), relayState: req.relayState, acs: req.acs };
  }
}
