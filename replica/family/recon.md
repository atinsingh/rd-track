# Parental-control recon for RoundDigital Track ("like Qustodio")

Prepared 2026-10-31. Public sources only: no logins, no binaries downloaded, no bulk scraping.
The session's own fetcher could not reach `qustodio.com`/`help.qustodio.com`, so those pages
were read through Firecrawl (a hosted scraper). Quotes are verbatim. **[UNVERIFIED]** marks a
claim I could not confirm from a primary source. **[INFERENCE]** marks my own reasoning.

---

## 0. TL;DR

- **Qustodio is three different products under one brand.** On Android it is an Accessibility +
  VpnService + Device Admin app. It also ships a sideloaded APK for calls/SMS, because Play
  does not allow that feature. On iOS it uses an MDM profile and a VPN that routes traffic
  "through Qustodio servers". iOS calls/messages come from a desktop app that reads a cable or
  Wi-Fi *backup*. On desktop it runs native agents. As a result, its feature parity and its
  reviews are poor (Kids App: 1.4★ on Play, 2.2★ on iOS; Trustpilot 2.5).
- **A new entrant should not copy the iOS approach.** Apple's App Review 5.5 allows MDM for
  parental control only "in limited cases". Apple's 2019 statement calls consumer MDM "incredibly
  risky". Since iOS 27, Qustodio's own cable-based anti-tamper no longer works. The clean path is
  Apple's **Screen Time API** (FamilyControls/ManagedSettings/DeviceActivity), which needs
  Apple's **distribution entitlement** (a manual review per bundle ID and per extension). It also
  has hard privacy walls: usage data cannot leave the device.
- **On Android, a Play-compliant product cannot read SMS or call logs.** Parental control is not
  on the exception list. It *can* use VpnService (parental control is a named permitted use),
  background location (Google's own example is child-safety geofencing) and Accessibility (with
  prominent disclosure and a declaration form). It must declare `isMonitoringTool=child_monitoring`,
  show a persistent notification and never hide.
- **Recommended order:** shared "Family" backend (reusing orgs, policy, audit, web, i18n, AWS) →
  Windows/macOS on the existing Rust agent → Android (Play) → iOS (Screen Time API) once the
  entitlement is approved. Position the product as **transparent parental control**: the child
  sees what the parent sees, which mirrors Track's "employees see everything their manager can see".

---

## 1. Qustodio feature inventory

### 1.1 Feature × platform matrix

Built from Qustodio's per-platform feature lists (https://www.qustodio.com/en/features/), the
pricing page footnotes (https://www.qustodio.com/en/premium/) and help-center articles cited inline.
✓ = Qustodio lists it for that platform; — = not listed; ⚠ = listed with a significant caveat.

| Feature | Android | iOS | Windows | macOS | Chromebook | Kindle |
|---|---|---|---|---|---|---|
| Web filtering by category, allow/alert/block, activity alerts | ✓ | ✓ (Safari + Chrome only) | ✓ | ✓ | ✓ | ✓ |
| SafeSearch | ✓ (pricing table, platforms not broken out) | ? | ? | ? | ? | ? |
| Games & apps blocking + per-app time limits | ✓ | ⚠ network-level only (see 2.1) | ✓ | ✓ | ✓ | ✓ |
| Daily time limits & restricted times | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Custom routines (study/bedtime modes) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Pause internet | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| YouTube monitoring | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Calls & SMS monitoring / call blocking | ⚠ APK outside Play only | ⚠ needs parent's Mac/PC (backup-based); no call blocking | — | — | — | — |
| Location, family locator, saved-places (geofence) alerts | ✓ | ✓ | — | — | — | — |
| Social monitoring (AI alerts on chats) | ✓ WhatsApp, Instagram, TikTok, Snapchat, X, LINE | ⚠ WhatsApp + Instagram per the features page (the pricing footnote says Instagram is Android-only; conflicting); set up via the desktop Calls & Messages app | — | — | — | — |
| AI-powered search/message alerts | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Gaming alerts / gaming voice-chat alerts | — | — | ✓ | — | — | — |
| Panic (SOS) button | ✓ (Android only) | — | — | — | — | — |
| App insights (age-appropriateness info) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Additional parent | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Uninstall/tamper protection | ✓ Device Admin + "Protect settings" | ⚠ "Qustodio Advance" desktop tool, **not compatible with iOS 27+** | ? | ? | ? | ? |

Sources and notes:
- Panic button: "\*Panic button and Instagram, TikTok, Snapchat and X message alerts are only
  available for Android. Calls & messages for iOS requires a Windows or Mac computer."
  (https://www.qustodio.com/en/premium/)
- Social monitoring "uses AI to help you stay informed when your child discusses potentially
  concerning topics on WhatsApp, Instagram DM, Snapchat, TikTok, X (Twitter) or LINE, such as
  bullying, self-harm…". Parents get "a snippet of the conversation, including who your child was
  chatting with". (https://help.qustodio.com/hc/articles/360005216697)
- Reports: "Receive detailed daily and weekly reports of your child's online activity straight to
  your inbox", plus a real-time dashboard and timeline (https://www.qustodio.com/en/features/).
  The pricing table lists "30-day activity reports".
- Minimum versions on child devices: iOS 15+, Android 9+, Fire OS 6+ (standard profiles only, not
  Amazon Child Profiles), Windows 10+, macOS 10.15 to 26, Chromebooks with Play. No Linux.
  (https://help.qustodio.com/hc/articles/360005225958)
- Supported browsers are limited, for example "iOS devices: Google Chrome and Safari". Also
  "Qustodio will automatically block unsupported browsers by default." (same article)
- **Parent app vs kids app.** There are three surfaces: the "Kids App Qustodio" on each child
  device; the "Parents App" (iOS 16+/Android 7+) or the "Qustodio Web" dashboard; and, for iOS
  calls/messages, a separate "Calls & Messages app" on the parent's Mac/PC. (same article)
  Qustodio Advance for iOS is a fourth app.
- **AI chatbot monitoring** (ChatGPT etc.): I found no Qustodio claim to monitor AI-assistant chats
  specifically. Their "AI-powered alerts" use AI *on* chat and search content. **[UNVERIFIED]**
  whether AI-chat apps are covered.

### 1.2 Pricing (US, read 2026-10-31 from https://www.qustodio.com/en/premium/)

| Tier | Price | Devices | Notes |
|---|---|---|---|
| Free | $0 | 1 | "can protect a single device and includes basic protection features" |
| Basic (Premium) | **$59.95/yr** ("Same as $5.00/month"). The page also shows **$72.94/yr**, probably a list or renewal price **[UNVERIFIED which]** | up to 5 | Care Plus phone support add-on: $12.99 |
| Complete (Premium) | **$104.95/yr** ("Same as $8.75/month") | "Unlimited\*" (family devices; "does not apply to schools or businesses") | FAQ: adds "calls & messages monitoring, custom rules for web, apps and games, YouTube monitoring, and more", plus Care Plus |

There is a 30-day money-back guarantee. The per-feature checkmarks in the pricing table are images
and were not machine-readable, so the Basic vs Complete split above comes from the FAQ text only.

---

## 2. How it is done technically

### 2.1 What Qustodio actually does (its own docs)

**iOS: MDM profile + VPN, traffic-based app detection.**
- Setup has the parent "download Qustodio profile", go to Settings › Profile Downloaded, "Install",
  "Trust", and then "Change to Always Allow" for location.
  (https://help.qustodio.com/hc/articles/360005453517)
- "Qustodio for iOS helps you monitor your child's device using a Virtual Private Network (VPN)…
  It sends your child's network traffic through Qustodio servers where monitoring and rules can be
  enforced." Some networks block the VPN; routers may need "500 and 4500 UDP ports" (IPsec/IKEv2)
  open. (https://help.qustodio.com/hc/articles/360005220738)
- App detection and blocking: "Qustodio uses MDM and VPN technologies to identify which apps are
  being used. These technologies check when an app consumes internet data… When you block or set a
  time limit for a specific app, Qustodio blocks its internet connection." It also admits "Some iOS
  apps (such as WhatsApp, Brawl Stars or Clash Royale) use special internet connections that can't
  be blocked or accurately reported". (https://help.qustodio.com/hc/articles/360005217897)
- Its own help center concedes false positives: an ad or a "Like" button can show up as Facebook use.
  (https://help.qustodio.com/hc/articles/360005220738)
- "Lock device" blocks "any of the apps that are rated 4+ by the AppStore". **[INFERENCE]** This
  is an MDM app-rating restriction, not a Screen Time API shield.
- Anti-tamper ("Qustodio Advance"): a desktop app that, over a cable, "will install remote
  management". Afterwards the phone shows "Supervised and managed by Qustodio". Requires iOS 15 to 26.
  "**Qustodio Advance is not compatible with iOS 27 or later.**"
  (https://help.qustodio.com/hc/articles/20084558366482). A third-party tester reports that on
  iOS 27 "A child can press Remove Management in settings, and it actually disconnects the MDM"
  (https://www.techlockdown.com/articles/does-qustodio-tamper-protection-work-ios-27). The tester
  is not neutral, but its finding matches Qustodio's own notice.
- iOS calls/SMS/iMessage: requires the parent's Mac/PC running Qustodio's Calls & Messages app, a
  cable, and both devices on the same Wi-Fi. One help error message mentions there is not "enough
  space for the backup". **[INFERENCE]** It parses local iPhone backups.
  (https://help.qustodio.com/hc/articles/4986837688465, via search excerpt)

**Android: Accessibility + VpnService + Device Admin; calls/SMS only off-Play.**
- The Play listing states: "This app uses the Device Administrator permission. This will prevent a
  user from uninstalling Kids App Qustodio without your knowledge." It also says "This app uses
  Accessibility services…" and "This app uses the VPN service to filter inappropriate web content."
  (https://play.google.com/store/apps/details?id=com.qustodio.qustodioapp). The listing shows
  1.4★ from 56.9K reviews, updated Oct 28, 2026.
- "due to Google Policies, the Kids App version on the Google Play Store does not include calls &
  SMS monitoring. It is only available on the full version downloaded from this help article."
  Install steps include "Install unknown apps", "If a Google Play Protection warning appears, tap
  'More details' and then 'Install anyway'", and, on Android 13+, "Allow restricted settings". It
  cannot see RCS/MMS ("Turn RCS chats off"). (https://help.qustodio.com/hc/articles/360005217237)
- **[INFERENCE]** Policy risk: Play's Stalkerware policy says listings "must not provide any means
  to activate or access functionality that violate these terms, such as linking to a non-compliant
  APK hosted outside Google Play". Qustodio's help mentions an "Instructions for Android" button in
  the Parents App that leads to this APK flow. I have not verified what that button does. Do not
  replicate this.

### 2.2 iOS: what the platform allows

**Screen Time API (FamilyControls + ManagedSettings + DeviceActivity), iOS/iPadOS 15+.**
- Authorization modes: for a child, "requires approval from a parent or guardian in the same Family
  Sharing group". For an individual, the device owner self-authorizes with biometrics. With child
  authorization, deleting the app is blocked, and while the app is authorized "the user can't sign
  out of iCloud". (https://developer.apple.com/documentation/familycontrols)
- ManagedSettings can "limit media showings, restrict app purchases, lock passcode settings" and
  shield apps, categories and web domains. Apps and sites are **opaque tokens** ("A representation
  of an activity, such as an app or website, that doesn't reveal its identity").
  (https://developer.apple.com/documentation/managedsettings)
- DeviceActivity "executes your code even when your app isn't running". Schedules and time-limit
  thresholds wake an extension that can update shields.
  (https://developer.apple.com/documentation/managedsettings/connectionwithframeworks)
- **Hard privacy wall:** a usage report extension "runs in a sandbox. This sandbox prevents your
  extension from making network requests or moving sensitive content outside the extension's
  address space". (https://developer.apple.com/documentation/deviceactivity/deviceactivityreport).
  The same page shows a filter with `users: .children`, and data is available "on the device(s) of
  children in their iCloud family". **[INFERENCE]** A native iOS parent app can *render* a child's
  usage, but your web dashboard cannot receive per-app usage from iOS. You only get your own
  events (threshold reached, shield shown).
- **[UNVERIFIED]** Whether tokens picked on the parent's device can be applied on the child's device
  is reported to work inconsistently in developer forums. Prototype this early.
- **Entitlement:** "Before you distribute an app that uses Family Controls, your Apple Developer
  Account Holder must request permission to use the Family Controls entitlement". Submit "the same
  request for the extension" (Device Activity Monitor, Report, Shield Action, Shield Configuration).
  "Apple reviews your app, and if it's approved, adds the entitlement…"
  (https://developer.apple.com/documentation/familycontrols/requesting-the-family-controls-entitlement).
  Developer forums report weeks of silence and no status visibility
  (https://developer.apple.com/forums/thread/824665, https://developer.apple.com/forums/thread/735888).
  Treat this as the critical-path item.
- **Web filtering:** per TN3134, an NE content filter on iOS is allowed on "supervised devices only"
  (iOS 9+), for "apps using Screen Time APIs" (iOS 15+), or "per-app on managed devices" (iOS 16+).
  "In the Screen Time case, content filters are only supported on child devices." A DNS proxy is
  supervised or managed only.
  (https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)
  Simpler: ManagedSettings web-domain shields and Apple's built-in adult-content limit.
- **Location** is separate (CoreLocation "Always" authorization plus background modes). It is not
  part of the Screen Time API. **[platform knowledge, not re-verified in this pass]**
- **What iOS will not give you without MDM or backups:** SMS/iMessage/call contents, other apps'
  message contents, uninstall protection outside FamilyControls child mode, or exportable per-app usage.
- **VPN route (Qustodio's):** Guideline 5.4: "Parental control, content blocking, and security apps,
  among others, from approved providers may also use the NEVPNManager API". VPN apps "may only be
  offered by developers enrolled as an organization" and "may not sell, use, or disclose to third
  parties any data". (https://developer.apple.com/app-store/review/guidelines/)
- **MDM route:** Guideline 5.5: MDM apps "must request this capability from Apple… may only be
  offered by commercial enterprises, educational institutions, or government agencies, and in
  limited cases, companies using MDM for parental control services". (same page)
- **2019 crackdown:** Apple said consumer MDM "is incredibly risky—and a clear violation of App Store
  policies—for a private, consumer-focused app business to install MDM control over a customer's
  device". It gave developers "30 days" to comply.
  (https://www.apple.com/newsroom/2019/04/the-facts-about-parental-control-apps/)
  Developers argued the motive was competition with Screen Time; Apple denied it
  (https://techcrunch.com/2019/04/28/apple-defends-its-takedown-of-some-apps-monitoring-screen-time).
  The 2019 statement and today's 5.5 wording ("limited cases… parental control") show Apple
  tolerates some incumbents. A new entrant should assume no.
- Newer iOS 26 age-assurance pieces (Declared Age Range, PermissionKit "significant change"
  consent) are relevant for age gating, not control
  (https://developer.apple.com/support/age-assurance/, via search; **[UNVERIFIED]** exact release details).

### 2.3 Android: what the platform and Play policy allow

| Mechanism | Use in parental control | Policy status (source) |
|---|---|---|
| **UsageStatsManager** (`PACKAGE_USAGE_STATS`, granted by the user in Settings) | Per-app foreground time, the basis for limits and reports | Special access, granted by the user. It can be revoked, so pair it with tamper alerts. A developer write-up warns that polling + overlay "is not parental-control-grade enforcement" (https://dev.to/rexa/how-to-block-apps-on-android-without-an-accessibilityservice-5gog) |
| **AccessibilityService** | Reliable foreground-app detection, blocking screens, URL reading in browsers, settings protection | Monitoring apps are explicitly **not** accessibility tools: "Other examples of apps that are not accessibility tools are: antivirus software, automation tools, assistants, **monitoring apps**…". They must show an in-app prominent disclosure with "affirmative user action for consent", separate from other disclosures, and complete the Permission Declaration Form. "Deceptive and non-declared uses… may result in a suspension" (https://support.google.com/googleplay/android-developer/answer/10964491) |
| **VpnService** (local, on-device DNS/HTTP filter) | Web filtering, pause internet, app network blocking | Permitted exceptions include "**Parental control** and enterprise management apps". You must declare the use, "Document your use of VpnService in your Google Play listing" and "Encrypt the data from the device to the VPN tunnel endpoint" (https://support.google.com/googleplay/android-developer/answer/12564964) |
| **Background location** | Locator, geofences | Google's own example: "a family companion app uses location in the background… to trigger an alert if a child leaves a geo-fenced region". Requires a declaration form (one feature only), a ≤30 s video, and an in-app disclosure using the word "location" plus "when the app is closed or not in use" (https://support.google.com/googleplay/android-developer/answer/9799150) |
| **SMS / Call Log permissions** | Reading texts and calls | **Not available to parental control on Play.** Use is limited to default SMS/Phone/Assistant handlers. The exception list (backup, caller ID, device automation, *enterprise* device management "for corporate entities for their employees", etc.) has no parental-control entry (https://support.google.com/googleplay/android-developer/answer/10208820). This is why Qustodio sideloads |
| **Device Admin (legacy)** | Uninstall friction | Deprecated for enterprise; keyguard/camera/password policies throw on targetSdk 29+. Consumer lock/wipe policies remain (https://developers.google.com/android/work/device-admin-deprecation) |
| **Android Enterprise / Android Management API** (device owner) | Strong lockdown | Not for this use case. The API "is restricted to commercial EMM developers", and "Solutions developed exclusively for the purpose of device or user monitoring… independent of enterprise management" are not allowed (https://developers.google.com/android/management/permissible-usage). Device-owner mode also needs a factory reset to provision **[platform knowledge]** |
| **Google Family Link** | Alternative/integration | Free, covers Android and ChromeOS (screen time, app approval, location, Chrome/YouTube/Play filters: https://families.google/familylink/). **No public third-party API found.** Only reverse-engineered cookies, per a Home Assistant thread (https://community.home-assistant.io/t/google-family-link-integration/166986). Qustodio tells users to disable Family Link before installing its APK |

**Stalkerware / monitoring-app rules (Play Malware policy).** These apply to us directly
(https://support.google.com/googleplay/android-developer/answer/9888380):
- Only apps "exclusively designed and marketed for monitoring another individual, for example
  parents to monitor their children" qualify. They "cannot be used to track anyone else (a spouse,
  for example) even with their knowledge and permission".
- "Apps must not present themselves as a spying or secret surveillance solution."
- "Apps must not hide or cloak tracking behavior or attempt to mislead users about such functionality."
- "Apps must present users with a **persistent notification at all times** when the app is running
  and a **unique icon** that clearly identifies the app."
- "Apps must disclose monitoring or tracking functionality in the Google Play store description."
- No "linking to a non-compliant APK hosted outside Google Play".
- The manifest must include `<meta-data android:name="isMonitoringTool" android:value="child_monitoring"/>`
  in every version code, and "Google Play will inform the user that there is a monitoring
  application on the device with a warning string through Google Play Protect."
  (https://support.google.com/googleplay/android-developer/answer/12955211)

**Sideloading is getting harder.** Android 13 "Restricted Settings" block sideloaded apps from
Accessibility and Notification Listener until the user toggles "Allow restricted settings" (see
Qustodio's own instructions above). Android 15 reportedly widens this to usage access, device admin
and overlays (https://androidauthority.com/android-15-restricted-settings-sideloading-3481098;
secondary source). **Android developer verification** began "September 30, 2026… in select regions"
(Brazil, Indonesia, Singapore, Thailand), with "user protections globally in 2027"
(https://developer.android.com/developer-verification). An APK side channel is a shrinking option.

**Battery and OEMs:** an always-on VpnService, background location and a foreground service
(needed for the persistent notification) are the main drains. A reviewer measured "about a 10 to 15
percent increase in battery drain" with Qustodio (https://www.security.org/parental-controls/qustodio/,
via search excerpt). Aggressive OEM task killers on Samsung, Xiaomi and others are a known support
burden. **[platform knowledge]**

### 2.4 Desktop: mapping onto the existing Rust/Tauri agent

What the repo already has, from a quick look: `rd-agent-core` (activity, apps, browser, limits,
policy, outbox/sync, i18n, screenshot), `rd-agent` with native Windows (`windows-sys`) and macOS
(`objc2`) collectors, a Tauri tray app (`rd-agent-desktop`, autostart, updater, deep-link), and a
Chromium/Firefox **browser extension** (`agent/browser-extension`, domain tracking).

| Parental feature | Reuse | New work |
|---|---|---|
| App usage reports, per-app/category time | `apps.rs`, `activity.rs`, ingestion, insights | Category taxonomy for games/social |
| Daily limits, schedules/routines | `limits.rs`, `policy.rs`, scheduling contracts | Enforcement: full-screen lock overlay, kill/suspend process, log-off; child-facing countdown |
| Web activity & filtering | Browser extension (`domain.js`, `tracker.js`) | Blocking via `declarativeNetRequest`, category DB/feed, SafeSearch enforcement (DNS rewrite to forcesafesearch hosts) |
| OS-wide web filter (all browsers) | none | macOS: NE content-filter **system extension**, which needs no supervision on macOS 10.15+ (TN3134 above) plus a Developer ID system-extension entitlement. Windows: WFP callout driver (needs signing) or a local DNS filter. The DNS option is cheaper but bypassable with DoH **[INFERENCE]** |
| Pause internet | none | Same filter, block-all mode |
| Tamper resistance | autostart, updater | Run as a service under a separate admin account; child uses a standard account; heartbeat → "device offline/agent removed" alert |
| Screenshots | `screenshot.rs` (policy-gated, audited) | **Recommend OFF for parental use.** It is stalkerware-adjacent and Qustodio does not offer it |

Note: Qustodio itself excludes Linux, and on Mac it uses macOS 10.15 to 26 only (help article above).

---

## 3. Legal and compliance

**United States: COPPA.** The rule covers operators "directed to children under 13" or with "actual
knowledge" of collecting their data. "Personal information" includes a "persistent identifier",
"Geolocation information sufficient to identify street name and name of a city or town", and
photos, video or audio of the child (https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions).
A parental-control service collects exactly this from the child's device, so assume COPPA applies.
The **2025 amendments** were effective June 23, 2025, with **compliance required by April 22, 2026**.
They add separate verifiable parental consent for third-party disclosure, written security and
retention policies, and expanded notices
(https://www.hunton.com/privacy-and-cybersecurity-law-blog/coppa-rule-amendment-compliance-deadline-approaches,
law-firm summary). In practice: the parent is the account holder and gives consent at signup, with
no third-party sharing, ads or analytics SDKs on the child app. **[INFERENCE; get counsel]**

**EU: GDPR Art. 8.** The age of digital consent is 16 by default, and Member States may lower it
to no less than 13 (https://gdpr-text.com/read/article-8/). Art. 8 bites when consent is the lawful
basis for an ISS offered to a child. Teen monitoring raises proportionality and DPIA questions.
A DPIA is effectively mandatory for systematic monitoring of children. **[INFERENCE]**

**UK: Age Appropriate Design Code, Standard 11 (Parental controls).** "If your online service allows
parental monitoring or tracking of a child, you should provide age appropriate resources to explain
the service to the child… You should provide a **clear and obvious sign for the child (such as a lit
up icon)** which lets them know when monitoring or tracking is active." It also asks you to give
parents information about the child's privacy rights under the UNCRC.
(https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/11-parental-controls/)

**Canada (likely home market, AWS ca-central-1).**
- PIPEDA / OPC: the OPC's position is that, barring exceptional cases, children under 13 cannot give
  meaningful consent, so a parent or guardian consents (OPC Meaningful Consent Guidelines, via
  summaries: https://www.mondaq.com/canada/privacy-protection/1561100/;
  **[UNVERIFIED against primary OPC text in this pass]**).
- Québec Law 25: "The consent of a minor under 14 years of age is given by the person having
  parental authority or by the tutor". Ages 14+ can consent themselves (Private Sector Act s. 4.1,
  via https://www.dialoginsight.com/en/blog/law-25-en/impact-of-law-25-on-consents). The product
  needs a **13 vs 14 split by province**. EN/FR i18n is already a requirement in Québec.
- Criminal Code s. 184 (interception of private communications) has a one-party-consent defence. A
  parent reading a child's messages via software is *not* a party
  (https://laws-lois.justice.gc.ca/eng/acts/c-46/page-29.html). **[UNVERIFIED; no case law
  checked]** This is a strong reason **not** to ship message-content capture in Canada.

**Anti-stalkerware.** The Coalition Against Stalkerware definition: "software, made available
directly to individuals, that enables a remote user to monitor the activities on another user's
device without that user's consent and without explicit, persistent notification". It adds that
consent is not shown "when apps merely require physical access to the device, unlocking the device,
or logging in". Its detection criteria include "hiding that they are installed, making it difficult
to uninstall, requiring extra privileges, hiding their activity"
(https://stopstalkerware.org/information-for-tech-companies/). Note that "difficult to uninstall"
is a criterion, which is in tension with parents' #1 complaint (kids uninstall it). The safe
answer is visible tamper *alerts* rather than stealthy tamper *prevention*.

**Safeguards a legitimate product must have** (synthesised from Play, ICO, Coalition and Apple above):
1. Always-visible indicator on the child device (persistent notification on Android; on iOS the app
   icon plus Screen Time's system UI). No hide-icon, no stealth mode, no disguised name.
2. A child-facing "what my parent can see" screen, which reuses Track's "employees see everything
   their manager can see" principle, plus age-appropriate explanations.
3. Minors only: require the child's date of birth, block profiles of 18+, and on iOS use Family
   Sharing child accounts. Use attestations at signup that the parent is the legal guardian.
4. Teen mode (13+, or 14+ in QC): fewer monitored categories, rules negotiated with the teen,
   location shared both ways, and no content reading.
5. No message, keystroke or screenshot capture in MVP. If AI alerts come later, run them on-device
   and send only the alert category, never transcripts.
6. Tamper → alert the parent, and notify the child; do not try to make the app unremovable by
   trickery.
7. A DPIA, data minimisation, short retention (Qustodio shows 30 days), Canadian data residency,
   no ads or SDK sharing, and COPPA-grade security and retention documentation.
8. An abuse path: a support process for reports of use against an adult partner, plus account bans.

---

## 4. What users complain about (top 8)

Ratings: Kids App iOS **2.2★ / 7.9K ratings**
(https://apps.apple.com/us/app/kids-app-qustodio/id990229433?see-all=reviews). Kids App Play
**1.4★ / 56.9K** (https://play.google.com/store/apps/details?id=com.qustodio.qustodioapp). Parents
App Play **3.6★ / 24.6K, 10M+ installs**
(https://play.google.com/store/apps/details?id=com.qustodio.family.parental.control.app.screentime).
Trustpilot **2.5 / 722 reviews** (https://www.trustpilot.com/review/www.qustodio.com).

1. **Kids bypass or uninstall it.** "useless app, my son keeps uninstalling it !"
   (https://www.trustpilot.com/reviews/6ac756c22b9633467517bd96). "13 and 14 yearold seem to by
   pass the restrictions… Even when i block tiktok and roblox they somehow manage to access it"
   (https://www.trustpilot.com/reviews/6aaf9cb777b11f9efa46abad). "My son has managed to remove
   this application from his device , and the app was not quick enough to update me"
   (https://www.trustpilot.com/reviews/6ab96123bd7d728684d1307b). "super easy to bypass"
   (https://www.reddit.com/r/insaneparents/comments/djv1fd/, search excerpt).
2. **The iOS VPN breaks apps and networks.** "The VPN and Snapchat are not compatible and snaps
   cannot be loaded or read while it is turned on… With the VPN switched off Qustodio is essentially
   useless." (https://www.trustpilot.com/reviews/6ab4d8883b14ef1473db9381). "This caused me slow
   data every single time" (https://www.reddit.com/r/Parenting/comments/1dkf6ol/success_with_qustodio/,
   search excerpt).
3. **Setup is complex and spread across too many apps.** "There is a kids app, parents app, parents
   advance app - all confusing and cumbersome to use… I've completely given up trying to control
   her IPAD." (https://www.trustpilot.com/reviews/6ac7ddb86576d4ae3c8e02c0). "Wsted many hours
   trying to set up." (https://www.trustpilot.com/reviews/6ab879d80cf7828b9ddac2f9)
4. **iOS calls & messages don't sync.** "I left it connected for hours and it remained at 0%."
   (Trustpilot, Sep 27 2026, https://www.trustpilot.com/review/www.qustodio.com). "it does not
   actually show me the calls and messages despite ensuring we are on the same WiFi network"
   (https://www.trustpilot.com/reviews/6aa58c3242537af021147436).
5. **Rules don't enforce, or enforce wrongly.** "When I went to block things they didn't block even
   when they said they were." (https://www.trustpilot.com/reviews/6ab2a581b53a762ce6d40c8e). "Why
   did it only block four, but allow all of the others?" (App Store review, Kindle, link above).
   "can be on a call when "blocked"" (Play Parents App review, link above). "it was locking apps at
   will" (https://www.reddit.com/r/parentalcontrols/comments/1r96rnc/, search excerpt).
6. **Over-blocking and collateral breakage.** "EVERY WEBSITE ON THE MACBOOK IS RESTRICTED.
   WIKIPEDIA, GOOGLE DOCS, SCHOOL RESOURCES." (https://www.trustpilot.com/reviews/6ac46655ac417539f10d8273).
   "It blocks Split Screen on my Samsung Fold, my banking app no long..." (Trustpilot summary card,
   truncated). "I cannot use some of the desktop apps (for example, Roblox Studio)" (Trustpilot
   summary card).
7. **Phones locked up or "bricked".** "it locked me out of my phone completely… I was 3 days without
   a phone" (App Store, link above). "it bricked the phones on 2 seperate occasions" (Trustpilot main
   page). "AVOID - breaks phones" (https://www.trustpilot.com/reviews/6aba2deb37f7e5da6427bda6).
8. **Support, billing and inaccurate data.** "super hard to cancel the subscription"
   (https://www.trustpilot.com/reviews/6adb8b7f6509e23330789084). "the tracker was last updated at
   8:30" (https://www.trustpilot.com/reviews/6abc0e6cc19becbafef9f463). "Too many false alarms"
   (Trustpilot summary card). Trustpilot's AI summary: "customer service was completely unhelpful".

A signal for product design: children write many of the 1-star kids-app reviews ("I feel like it is
my mother invading my privacy", App Store). Reddit also complains about the always-on Accessibility
overlay ("forcing some … bubble on my screen",
https://www.reddit.com/r/parentalcontrols/comments/1pl1dpn/, search excerpt). Transparency and
teen-respecting defaults are an opening for a competitor.

---

## 5. Competitors (one line each)

| Product | Positioning | Price (source) |
|---|---|---|
| **Bark** | AI alerts on texts, social, email and web, plus screen time and location; monitoring-first | $14/mo or $99/yr for the full plan (https://www.bark.us/pricing/). Bark Jr, a cheaper tier, exists **[UNVERIFIED price]** |
| **Google Family Link** | Free first-party controls for Android/ChromeOS: limits, app approval, location, Chrome/YouTube/Play filters | Free **[UNVERIFIED on page; widely known]** (https://families.google/familylink/) |
| **Apple Screen Time** | Built into iOS/macOS through Family Sharing; the baseline every iOS rival must beat; also the API you would build on | Free (built in) |
| **Net Nanny** (SafeToNet) | Web-filter heritage, real-time content analysis | $39.99/yr (1 device), $54.99/yr (5), $89.99/yr (20) (https://www.netnanny.com/products/) |
| **Norton Family** | Bundled with Norton 360 Deluxe/Premium; Windows/Android/iOS, **no Mac** | $49.99/yr (https://us.norton.com/products/norton-family) |
| **Aura** (owns Circle) | Identity-theft and security suite plus parental controls | Kids $10/mo billed annually; Family $32/mo billed annually (https://www.aura.com/parental-controls) |
| **mSpy** (counter-example) | Marketed for covert monitoring. Its customer-support tickets leaked in 2024 ("millions of customer support tickets", https://techcrunch.com/2024/07/11/mspy-spyware-millions-customers-data-breach/). It is the archetype of what the Coalition and Play policy prohibit | Not checked (pricing page 404) |

---

## 6. Recommendation

### 6.1 Positioning
"Transparent parental control from the team behind privacy-first time tracking." Reuse Track's
existing promises: data minimisation, everything visible to the monitored person, published and
versioned policy, audited views, Canadian hosting, EN/FR. Don't compete with Bark on reading
messages. Compete with Qustodio on **reliability, one-app setup and teen trust**, which are its
top complaints (#3, #5, #7 and the child-review signal).

### 6.2 MVP by platform, in order

**Phase 0: Family backend (≈ reuse-heavy).** "Family" org type: parents are admins/managers, children
are member profiles with a DOB, devices link to a child. Extend the `packages/contracts/src/policy.ts`
scope model (organization/team/device) with parental fields: daily budget, schedules ("routines"),
category and app block lists, web category rules, pause. Reuse ingestion/outbox, insights for
reports, the email module for daily/weekly digests, audit for "who viewed what", the privacy module
for the child-visible view, Stripe billing (per-family plan instead of per-seat), i18n EN/FR, and
AWS ca-central-1. Add a parent mobile web dashboard or a thin wrapper first, not native.

**Phase 1: Windows + macOS on the Rust agent.** These ship fastest, need no store approval and
reuse the most code. Scope: app/category usage, daily limits + schedules with a lock screen,
browser-extension web filtering + SafeSearch, pause internet (extension-level), heartbeat/tamper
alerts, and a child tray UI that shows "what's monitored" and time left. Later: macOS
NE system-extension filter and Windows WFP or DNS for all-browser filtering.

**Phase 2: Android (Google Play only, no APK side channel).**
1. Usage access → reports and limits; foreground service + persistent notification (policy-mandated).
2. Blocking: Accessibility (more reliable, but needs a prominent disclosure + declaration form + Play
   review) **or** usage-stats polling + overlay (weaker, simpler review). Start with Accessibility
   behind a clear consent screen. **[INFERENCE]**
3. Local VpnService DNS filter for web categories, SafeSearch and pause internet; declare "Parental
   control"; list it in the store description.
4. Background location + geofences: one declaration ("child safety geofencing"), a 30 s video, and
   disclosure text.
5. `isMonitoringTool=child_monitoring`; Device Admin only for consumer-allowed friction. Tamper →
   parent alert.
6. Explicitly **out of scope:** SMS and call logs (Play-ineligible), notification-content reading,
   message AI.

**Phase 3: iOS via the Screen Time API (no MDM, no VPN).** File the Family Controls distribution
entitlement request **on day 1 of the project** for the app plus all four extensions. Scope:
`.child` authorization (needs a Family Sharing child account), ManagedSettings shields (apps,
categories, web domains), DeviceActivity schedules and limits, adult-content web limit,
CoreLocation location. The parent-side iOS app renders DeviceActivityReport. The web dashboard
shows only aggregate/threshold events, so explain this to users. Expect an "iOS shows less than
Android" parity gap; Qustodio has the same gap, through different means.

**Later / maybe:** a Panic/SOS button (simple on both platforms: share location + notify), YouTube
watch history (Android Accessibility only), Chromebook (Play app ≈ the Android build), on-device
AI alert categories, and an optional DNS-profile product for routers.

### 6.3 Hardest parts (ranked)
1. **Apple Family Controls distribution entitlement.** Manual and opaque, with weeks to months of
   reported silence, and approval is not guaranteed. It blocks all iOS distribution, including
   TestFlight.
2. **Google Play declarations and review.** Accessibility, VpnService and background location each
   have a form; you also need the stalkerware compliance list (persistent notification, unique icon,
   disclosure). Rejections loop. The child app's target audience may pull in the Families policy too
   **[UNVERIFIED]**.
3. **Web filtering quality.** You need a category database (license one, e.g. a commercial URL-category
   feed, or use DNS resolvers with family categories). Without it you get #5/#6 complaints. Watch
   DoH/Private Relay bypass and over-blocking.
4. **Enforcement reliability and battery.** OEM background killers, VPN battery cost (10–15%
   reported), time-change and offline cases, and tamper without stealth.
5. **iOS data wall.** The sandboxed report extension means no server-side iOS usage analytics. Design
   the dashboard around it.
6. **Legal.** COPPA 2025 rule documentation, Québec <14 consent, Criminal Code s. 184 if anyone
   proposes reading messages, and a DPIA for the EU/UK.

### 6.4 What RoundDigital Track pieces carry over
| Existing piece | Reuse for parental control |
|---|---|
| Multi-tenant orgs, roles, authz (`apps/api/src/modules/org`, `authz.ts`) | Family = org; parent/co-parent roles; child profiles |
| Policy model + resolver (`packages/contracts/src/policy.ts`, partial-policy ADR) | Parental rule sets per child or device, versioned and published |
| Devices + links + updates modules | Child device enrollment, agent update channel |
| Ingestion/outbox/sync (agent + API) | Usage and event pipeline from all clients |
| Insights, exports, retention | Daily/weekly reports, 30-day retention |
| Privacy module + audit + "employee sees everything" principle | Child transparency view, parent-view audit (a differentiator) |
| Rust agent (native collectors, `limits.rs`, Tauri tray) + browser extension | The entire Windows/macOS product |
| Email, i18n EN/FR, Stripe billing, signup | Digests, bilingual UX, family subscriptions |
| AWS Terraform (ca-central-1) | Canadian data residency claim |
| Screenshots module | **Do not enable** for parental use |

---

## 7. Open questions / not verified
- The Basic tier's two prices ($59.95 vs $72.94/yr), and the exact Free and Basic feature splits (the table is image-based).
- Social monitoring scope on iOS: the features page says WhatsApp + Instagram; the pricing footnote says Instagram is Android-only.
- Whether Qustodio's Parents App on Play links to the off-Play APK (a possible Play policy issue). Not verified.
- Cross-device behaviour of Screen Time tokens, and current real-world entitlement approval times (forum anecdotes only).
- Exact current Android 15/16 restricted-settings scope; whether Play's Families policy applies to a child-companion app.
- Canadian OPC under-13 guidance and Criminal Code applicability to parental monitoring: verify with counsel.
- Bark Jr and mSpy current prices.
