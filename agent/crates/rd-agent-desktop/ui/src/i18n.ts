// The popover's own words in English and French (G27). Text that comes from the Rust side
// (status, banners, the session notice…) is already in the person's language; this is only
// what the UI writes itself. English is the source: every other language must have every
// key (the compiler checks). `{name}` is filled by t(key, { name }).

export type Lang = "en" | "fr";

export const en = {
  "error.generic": "Something went wrong",
  "error.couldNotStart": "The agent could not start.",
  "app.starting": "Starting…",
  "app.stopping": "Stopping the session and sending the last data…",

  "banner.dismiss": "DISMISS",
  "head.elapsed": "Elapsed",

  "pick.chooseProject": "Choose a project…",
  "pick.noProject": "No project",
  "pick.noTask": "No task",
  "pick.project": "Project",
  "pick.task": "Task",
  "pick.unsupported": "Your server does not list projects for this app yet. Sessions start without a project.",
  "pick.startHint": "Choose a project, then start the session.",

  "session.start": "Start session",
  "session.resume": "Resume",
  "session.pause": "Pause",
  "session.stop": "Stop",

  "day.mon": "Mon",
  "day.tue": "Tue",
  "day.wed": "Wed",
  "day.thu": "Thu",
  "day.fri": "Fri",
  "day.sat": "Sat",
  "day.sun": "Sun",

  "settings.label": "Settings",
  "settings.open": "Settings",
  "settings.close": "Close settings",
  "settings.reminders": "Reminders",
  "settings.remindersToggle": "Reminders",
  "settings.whenStart": "When my hours start",
  "settings.whenEnd": "When my hours end",
  "settings.everyHour": "Every hour after that, if still tracking",
  "settings.myHours": "My hours",
  "settings.start": "Start",
  "settings.end": "End",
  "settings.workdays": "Workdays",
  "settings.localOnly": "{today}. Reminders stay on this computer; nothing is sent to your organization.",
  "settings.thisComputer": "This computer",
  "settings.openAtLogin": "Open when I sign in to this computer",
  "settings.openAtLoginHint": "It waits in the menu bar or tray. Nothing is collected until you start a session.",

  "idle.welcome": "Welcome back",
  "idle.question": "What should happen to this time?",
  "idle.keep": "Keep it as working time",
  "idle.discard": "Remove it",
  "idle.move": "Move it to another project",
  "idle.noTarget": "There is no other project to move it to.",
  "idle.correction": "Handled like any time correction: if your organisation reviews corrections, your manager approves it first.",
  "idle.foot": "Your choice — your manager can't make it for you. Tracking carries on either way.",

  "main.today": "Today",
  "main.activity": " · activity ",
  "main.workLimit": "Work limit",
  "main.dashboard": "My dashboard →",
  "main.quit": "Quit",
  "main.stopQuit": "Stop & quit",

  "notice.whatChanged": "What changed",
  "notice.beforeStart": "Before you start",
  "notice.nowCollects": "This session now collects",
  "notice.lead": "While this session runs, RoundDigital Track records:",
  "notice.notCollected": "Not collected",
  "notice.never": "Never: {list}",
  "notice.ok": "OK",
  "notice.otherProject": "Choose another project",
  "notice.start": "Start session →",

  "enroll.setUp": "Set up this computer",
  "enroll.title": "Connect to your organization",
  "enroll.intro": "Use “Connect this computer” in Track on the web, or the server address and one-time code your administrator gave you. Nothing is recorded until you start a session.",
  "enroll.fromLink": "Filled in from a link. Check the server address is your organization’s before you connect.",
  "enroll.server": "Server address",
  "enroll.code": "Enrollment code",
  "enroll.codePlaceholder": "ABCDEFGHJK, or paste the link",
  "enroll.deviceName": "Device name (optional)",
  "enroll.deviceNamePlaceholder": "Defaults to this computer's name",
  "enroll.connecting": "Connecting…",
  "enroll.connect": "Connect",

  "managed.title": "Connect with your work email",
  "managed.intro": "Your IT team set this computer up for {server}. Enter your work email and we'll send you a one-time code. Nothing is recorded until you start a session.",
  "managed.email": "Work email",
  "managed.sending": "Sending…",
  "managed.send": "Email me a code",
  "managed.checkTitle": "Check your email",
  "managed.checkIntro": "If {email} can connect a computer, a code is on its way. It works once, for 30 minutes.",
  "managed.code": "Code from the email",
  "managed.again": "Send another code",
  "managed.adminCode": "I have a code from my administrator",

  "revoked.eyebrow": "Device removed",
  "revoked.title": "Tracking has stopped",
  "revoked.body": "Your organization removed this computer. Nothing is recorded and data that had not been sent was erased from this computer.",
  "revoked.again": "Enroll again",
} as const;

export type Key = keyof typeof en;

export const fr: Record<Key, string> = {
  "error.generic": "Une erreur est survenue",
  "error.couldNotStart": "L’agent n’a pas pu démarrer.",
  "app.starting": "Démarrage…",
  "app.stopping": "Arrêt de la session et envoi des dernières données…",

  "banner.dismiss": "FERMER",
  "head.elapsed": "Temps écoulé",

  "pick.chooseProject": "Choisir un projet…",
  "pick.noProject": "Aucun projet",
  "pick.noTask": "Aucune tâche",
  "pick.project": "Projet",
  "pick.task": "Tâche",
  "pick.unsupported": "Votre serveur ne fournit pas encore la liste des projets à cette application. Les sessions démarrent sans projet.",
  "pick.startHint": "Choisissez un projet, puis démarrez la session.",

  "session.start": "Démarrer la session",
  "session.resume": "Reprendre",
  "session.pause": "Mettre en pause",
  "session.stop": "Arrêter",

  "day.mon": "lun.",
  "day.tue": "mar.",
  "day.wed": "mer.",
  "day.thu": "jeu.",
  "day.fri": "ven.",
  "day.sat": "sam.",
  "day.sun": "dim.",

  "settings.label": "Paramètres",
  "settings.open": "Paramètres",
  "settings.close": "Fermer les paramètres",
  "settings.reminders": "Rappels",
  "settings.remindersToggle": "Rappels",
  "settings.whenStart": "Au début de mes heures",
  "settings.whenEnd": "À la fin de mes heures",
  "settings.everyHour": "Toutes les heures ensuite, si le suivi continue",
  "settings.myHours": "Mes heures",
  "settings.start": "Début",
  "settings.end": "Fin",
  "settings.workdays": "Jours de travail",
  "settings.localOnly": "{today}. Les rappels restent sur cet ordinateur; rien n’est envoyé à votre organisation.",
  "settings.thisComputer": "Cet ordinateur",
  "settings.openAtLogin": "Ouvrir quand je me connecte à cet ordinateur",
  "settings.openAtLoginHint": "L’application attend dans la barre des menus ou la zone de notification. Rien n’est recueilli tant que vous ne démarrez pas de session.",

  "idle.welcome": "Bon retour",
  "idle.question": "Que faire de ce temps?",
  "idle.keep": "Le garder comme temps de travail",
  "idle.discard": "Le retirer",
  "idle.move": "Le déplacer vers un autre projet",
  "idle.noTarget": "Il n’y a aucun autre projet vers lequel le déplacer.",
  "idle.correction": "Traité comme toute correction de temps : si votre organisation examine les corrections, votre gestionnaire l’approuve d’abord.",
  "idle.foot": "C’est votre choix — votre gestionnaire ne peut pas le faire à votre place. Le suivi continue dans tous les cas.",

  "main.today": "Aujourd’hui",
  "main.activity": " · activité ",
  "main.workLimit": "Limite de travail",
  "main.dashboard": "Mon tableau de bord →",
  "main.quit": "Quitter",
  "main.stopQuit": "Arrêter et quitter",

  "notice.whatChanged": "Ce qui a changé",
  "notice.beforeStart": "Avant de commencer",
  "notice.nowCollects": "Cette session recueille maintenant",
  "notice.lead": "Pendant cette session, RoundDigital Track enregistre :",
  "notice.notCollected": "Non recueilli",
  "notice.never": "Jamais : {list}",
  "notice.ok": "OK",
  "notice.otherProject": "Choisir un autre projet",
  "notice.start": "Démarrer la session →",

  "enroll.setUp": "Configurer cet ordinateur",
  "enroll.title": "Se connecter à votre organisation",
  "enroll.intro": "Utilisez « Connecter cet ordinateur » dans Track sur le Web, ou l’adresse du serveur et le code à usage unique fournis par votre administrateur. Rien n’est enregistré tant que vous ne démarrez pas de session.",
  "enroll.fromLink": "Rempli à partir d’un lien. Vérifiez que l’adresse du serveur est bien celle de votre organisation avant de vous connecter.",
  "enroll.server": "Adresse du serveur",
  "enroll.code": "Code d’inscription",
  "enroll.codePlaceholder": "ABCDEFGHJK, ou collez le lien",
  "enroll.deviceName": "Nom de l’appareil (facultatif)",
  "enroll.deviceNamePlaceholder": "Par défaut, le nom de cet ordinateur",
  "enroll.connecting": "Connexion…",
  "enroll.connect": "Connecter",

  "managed.title": "Se connecter avec votre courriel professionnel",
  "managed.intro": "Votre équipe des TI a configuré cet ordinateur pour {server}. Entrez votre courriel professionnel et nous vous enverrons un code à usage unique. Rien n’est enregistré tant que vous ne démarrez pas de session.",
  "managed.email": "Courriel professionnel",
  "managed.sending": "Envoi…",
  "managed.send": "M’envoyer un code",
  "managed.checkTitle": "Consultez vos courriels",
  "managed.checkIntro": "Si {email} peut connecter un ordinateur, un code est en route. Il fonctionne une seule fois, pendant 30 minutes.",
  "managed.code": "Code reçu par courriel",
  "managed.again": "Envoyer un autre code",
  "managed.adminCode": "J’ai un code de mon administrateur",

  "revoked.eyebrow": "Appareil retiré",
  "revoked.title": "Le suivi est arrêté",
  "revoked.body": "Votre organisation a retiré cet ordinateur. Rien n’est enregistré, et les données qui n’avaient pas été envoyées ont été effacées de cet ordinateur.",
  "revoked.again": "S’inscrire de nouveau",
};

const CATALOGUES: Record<Lang, Record<Key, string>> = { en, fr };

let current: Lang = "en";

/** Before the first view arrives: the computer's languages. */
export function browserLang(): Lang {
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  // The first preference we have: French for any fr-*, else English.
  for (const l of prefs) {
    const tag = (l ?? "").toLowerCase();
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

/** Switches the language the UI writes in, and the page's `lang`. */
export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
}

export type Vars = Record<string, string | number>;

export function t(key: Key, vars?: Vars): string {
  const s = CATALOGUES[current][key] ?? en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** The `one` or `other` form for `n`, by the language's own rule (French counts 0 as one). */
export function tPlural(n: number, one: Key, other: Key, vars?: Vars): string {
  const form = new Intl.PluralRules(current === "fr" ? "fr-CA" : "en-US").select(n);
  return t(form === "one" ? one : other, { n, ...vars });
}
