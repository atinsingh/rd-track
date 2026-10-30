//! The desktop app's words in each language it speaks (G27).
//!
//! Every entry has an English and a French text side by side, so a language can't miss
//! one: the macro below won't compile otherwise. `{name}` placeholders are filled with
//! [`fill`]. The language comes from the person's choice on the server (heartbeat),
//! else the computer's own language. Log lines stay English.

use serde::Serialize;

/// A language the app speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    /// English (the default).
    #[default]
    En,
    /// French.
    Fr,
}

impl Lang {
    /// From a BCP 47 tag such as `fr-CA` or `en_US.UTF-8`: French for `fr…`, else English.
    pub fn from_tag(tag: &str) -> Self {
        if tag.trim().to_ascii_lowercase().starts_with("fr") {
            Lang::Fr
        } else {
            Lang::En
        }
    }

    /// This language's words.
    pub fn messages(self) -> &'static Messages {
        match self {
            Lang::En => &EN,
            Lang::Fr => &FR,
        }
    }

    /// "29 Oct" / "29 oct." for a day and month (1-based month).
    pub fn day_month(self, day: u32, month: u32) -> String {
        const EN_M: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        const FR_M: [&str; 12] = [
            "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.",
            "nov.", "déc.",
        ];
        let i = (month.clamp(1, 12) - 1) as usize;
        match self {
            Lang::En => format!("{day} {}", EN_M[i]),
            Lang::Fr => format!("{day} {}", FR_M[i]),
        }
    }

    /// "71%" / "71 %".
    pub fn percent(self, p: u8) -> String {
        match self {
            Lang::En => format!("{p}%"),
            Lang::Fr => format!("{p}\u{a0}%"),
        }
    }
}

/// `text` in `lang` when it is one of the English entries (a message written in English
/// elsewhere, such as a licence refusal); otherwise unchanged.
pub fn translate(lang: Lang, text: &str) -> &str {
    if lang == Lang::En {
        return text;
    }
    ALL.iter()
        .find(|(_, en, _)| *en == text)
        .map_or(text, |(_, _, fr)| fr)
}

/// Fills `{name}` placeholders.
pub fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_owned();
    for (k, v) in vars {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

macro_rules! messages {
    ($( $name:ident: $en:literal => $fr:literal, )*) => {
        /// One language's words (see the module docs).
        #[derive(Debug)]
        #[allow(missing_docs)]
        pub struct Messages { $( pub $name: &'static str, )* }
        /// English.
        pub const EN: Messages = Messages { $( $name: $en, )* };
        /// French.
        pub const FR: Messages = Messages { $( $name: $fr, )* };
        /// Every entry as (name, English, French), for tests.
        pub const ALL: &[(&str, &str, &str)] = &[ $( (stringify!($name), $en, $fr), )* ];
    };
}

messages! {
    // What a session collects (word for word the web's "What's collected").
    collect_session_text: "When your session starts, pauses and stops" => "Le début, les pauses et la fin de votre session",
    collect_session_detail: "Plus the project and task you chose" => "Ainsi que le projet et la tâche choisis",
    collect_activity_text: "How many keyboard and mouse events happen each minute" => "Le nombre d’événements de clavier et de souris par minute",
    collect_activity_detail: "Counts only — never which keys or where you clicked" => "Des nombres seulement — jamais quelles touches ni où vous avez cliqué",
    collect_app_text: "The name of the app in front" => "Le nom de l’application au premier plan",
    collect_app_detail: "For example \"Visual Studio Code\"" => "Par exemple « Visual Studio Code »",
    collect_domains_text: "Website domains" => "Les domaines de sites Web",
    collect_domains_detail: "Domain only, e.g. \"github.com\" — never full addresses" => "Le domaine seulement, p. ex. « github.com » — jamais l’adresse complète",
    collect_titles_text: "Window titles and full URLs" => "Les titres de fenêtres et les URL complètes",
    collect_titles_detail: "Collected" => "Recueillis",
    collect_shots_text: "Screenshots" => "Captures d’écran",
    collect_shots_detail: "About one every {minutes} minutes, {monitors}, reduced to {width} px wide, kept {excluded}{days} days" => "Environ une toutes les {minutes} minutes, {monitors}, réduites à {width} px de large, conservées {excluded}{days} jours",
    collect_shots_primary: "primary monitor" => "écran principal",
    collect_shots_all: "all monitors" => "tous les écrans",
    collect_shots_excluded: "except when excluded apps are in front, " => "sauf quand une application exclue est au premier plan, ",
    collect_off: "Off for you" => "Désactivé pour vous",
    never_collected: "Which keys you press, typed text, passwords, clipboard, webcam, microphone, the content of messages, email or documents, and your location." => "Les touches sur lesquelles vous appuyez, le texte saisi, les mots de passe, le presse-papiers, la webcam, le micro, le contenu des messages, des courriels ou des documents, et votre position.",

    // Licence.
    license_inactive: "Tracking is unavailable: your organization's subscription is inactive" => "Le suivi n’est pas disponible : l’abonnement de votre organisation est inactif",
    license_no_seat: "Tracking is unavailable: no licence seat assigned" => "Le suivi n’est pas disponible : aucun poste de licence n’est attribué",
    license_ask: "{message}. Ask your administrator." => "{message}. Adressez-vous à votre administrateur.",
    license_grace: "Your organization's subscription is in its grace period{until}. Tracking continues." => "L’abonnement de votre organisation est en période de grâce{until}. Le suivi continue.",
    license_grace_until: " until {date}" => " jusqu’au {date}",

    // The popover.
    label_tracking: "TRACKING" => "SUIVI EN COURS",
    label_paused: "PAUSED" => "EN PAUSE",
    label_idle: "NOT TRACKING" => "AUCUN SUIVI",
    starting: "Starting…" => "Démarrage…",
    sync_offline: "Offline" => "Hors ligne",
    sync_offline_queued: "Offline · {n} queued" => "Hors ligne · {n} en attente",
    sync_unavailable: "Not syncing · tracking unavailable" => "Aucune synchronisation · suivi indisponible",
    sync_problem: "Sync problem · {n} queued, retrying" => "Problème de synchronisation · {n} en attente, nouvel essai",
    sync_up_to_date: "Up to date" => "À jour",
    sync_synced: "Synced {ago} ago" => "Synchronisé il y a {ago}",
    syncing: "Syncing…" => "Synchronisation…",
    camera_badge: "Screenshots on for this project · about every {n} min" => "Captures d’écran activées pour ce projet · environ toutes les {n} min",

    // The session-start notice.
    notice_title_project: "Start a session on {name}?" => "Démarrer une session sur {name}?",
    notice_title_none: "Start a session without a project?" => "Démarrer une session sans projet?",
    notice_paused: "Nothing is recorded while paused or after you stop." => "Rien n’est enregistré pendant une pause ni après l’arrêt.",
    notice_manager_views: "Your team manager can view these screenshots; every view is shown to you." => "Votre gestionnaire d’équipe peut voir ces captures d’écran; chaque consultation vous est montrée.",
    notice_managers_cannot: "Managers cannot view your screenshots under this policy." => "Selon cette politique, les gestionnaires ne peuvent pas voir vos captures d’écran.",
    notice_see_each: "You can see each screenshot and request its deletion in My dashboard." => "Vous pouvez voir chaque capture d’écran et en demander la suppression dans Mon tableau de bord.",
    notice_no_domains: "This version of the agent does not collect website domains, window titles or URLs." => "Cette version de l’agent ne recueille ni les domaines de sites Web, ni les titres de fenêtres, ni les URL.",
    notice_warning_project: "This project's policy could not be loaded yet (offline?). Screenshots stay off until it is; you will be told if that changes." => "La politique de ce projet n’a pas encore pu être chargée (hors ligne?). Les captures d’écran restent désactivées d’ici là; vous serez averti si cela change.",
    notice_warning_org: "Your organization's policy could not be loaded yet (offline?). Screenshots stay off until it is; you will be told if that changes." => "La politique de votre organisation n’a pas encore pu être chargée (hors ligne?). Les captures d’écran restent désactivées d’ici là; vous serez averti si cela change.",

    // Coming back after being away.
    no_project: "No project" => "Aucun projet",
    idle_title: "You were away for {duration}" => "Vous avez été absent pendant {duration}",
    idle_keep: "Keep {duration}" => "Garder {duration}",
    idle_remove: "Remove {duration}" => "Retirer {duration}",
    idle_move: "Move {duration}" => "Déplacer {duration}",
    idle_choose_project: "Choose the project to move this time to." => "Choisissez le projet où déplacer ce temps.",
    idle_choose_listed: "Choose one of the listed projects." => "Choisissez un des projets de la liste.",
    idle_choose_task: "Choose one of the project's tasks." => "Choisissez une des tâches du projet.",

    // Work limits.
    limit_detail: "Tracking continues — this is a heads-up from your organization's work limits." => "Le suivi continue — ceci est un avertissement lié aux limites de travail de votre organisation.",
    limit_reached_today: "You've reached today's {limit} limit" => "Vous avez atteint la limite de {limit} d’aujourd’hui",
    limit_reached_week: "You've reached this week's {limit} limit" => "Vous avez atteint la limite de {limit} de cette semaine",
    limit_pct_today: "{percent} of today's {limit} limit" => "{percent} de la limite de {limit} d’aujourd’hui",
    limit_pct_week: "{percent} of this week's {limit} limit" => "{percent} de la limite de {limit} de cette semaine",
    limit_line_today: "{worked} of {limit} today" => "{worked} sur {limit} aujourd’hui",
    limit_line_week: "{worked} of {limit} this week" => "{worked} sur {limit} cette semaine",
    got_it: "Got it" => "Compris",

    // Reminders.
    rem_ready: "Ready to start tracking?" => "Prêt à commencer le suivi?",
    rem_shift_started: "Your shift started at {time}." => "Votre quart a commencé à {time}.",
    rem_hours_started: "Your hours started at {time}." => "Vos heures ont commencé à {time}.",
    rem_shift_ended_title: "Your shift ended at {time}" => "Votre quart s’est terminé à {time}",
    rem_hours_ended_title: "Your hours ended at {time}" => "Vos heures se sont terminées à {time}",
    rem_shift_ended: "Your shift ended at {time}." => "Votre quart s’est terminé à {time}.",
    rem_hours_ended: "Your hours ended at {time}." => "Vos heures se sont terminées à {time}.",
    rem_session_still: "This session is still tracking." => "Cette session est toujours suivie.",
    rem_still: "Still tracking?" => "Toujours en suivi?",
    rem_start: "Start tracking" => "Commencer le suivi",
    rem_not_today: "Not today" => "Pas aujourd’hui",
    rem_stop: "Stop tracking" => "Arrêter le suivi",
    rem_keep: "Keep tracking" => "Continuer le suivi",
    rem_today: "Today {from}–{to}" => "Aujourd’hui {from}–{to}",
    rem_none_today: "No reminders today" => "Aucun rappel aujourd’hui",
    rem_schedule_note: "Your organization's schedule sets these hours" => "L’horaire de votre organisation fixe ces heures",
    rem_start_time: "Enter a start time like 09:00." => "Entrez une heure de début comme 09:00.",
    rem_end_time: "Enter an end time like 17:30." => "Entrez une heure de fin comme 17:30.",
    rem_end_after_start: "The end of your hours must be after the start." => "La fin de vos heures doit être après le début.",
    rem_unknown_day: "Unknown workday." => "Jour ouvrable inconnu.",

    // Banners.
    perm_fix: "Fix in System Settings" => "Corriger dans les Réglages Système",
    perm_allow: "Allow…" => "Autoriser…",
    perm_screen: "Screenshots for this project need the Screen Recording permission. None are taken until it is granted." => "Les captures d’écran de ce projet ont besoin de l’autorisation « Enregistrement de l’écran ». Aucune n’est prise tant qu’elle n’est pas accordée.",
    perm_input: "Keyboard and mouse counts need the Input Monitoring permission. Until then minutes are recorded without counts." => "Le décompte du clavier et de la souris a besoin de l’autorisation « Surveillance de l’entrée ». D’ici là, les minutes sont enregistrées sans décompte.",
    work_hours: "Outside your work hours — nothing is recorded until they start again." => "En dehors de vos heures de travail — rien n’est enregistré avant leur reprise.",
    collection_changed: "Your organization changed what this session collects. Review it now." => "Votre organisation a changé ce que cette session recueille. Vérifiez-le maintenant.",
    review: "Review" => "Vérifier",
    overlap: "Your session was stopped: another work session is already running for you." => "Votre session a été arrêtée : une autre session de travail est déjà en cours pour vous.",
    license_restored: "Tracking is available again." => "Le suivi est de nouveau disponible.",
    recovered_resumed: "Your session from before the restart was resumed." => "Votre session d’avant le redémarrage a repris.",
    recovered_closed: "A session left open before a restart was closed at the time the agent last ran." => "Une session laissée ouverte avant un redémarrage a été fermée au moment où l’agent fonctionnait pour la dernière fois.",
    update_ready: "Version {version} is ready." => "La version {version} est prête.",
    update_restart: "Restart to update" => "Redémarrer pour mettre à jour",
    simulated: "Development build: simulated input and screen (no native collectors on this OS)." => "Version de développement : clavier, souris et écran simulés (pas de collecteurs natifs sur ce système).",

    // Tray.
    tray_unavailable: "RoundDigital Track — tracking unavailable" => "RoundDigital Track — suivi indisponible",
    tray_not_tracking: "RoundDigital Track — not tracking" => "RoundDigital Track — aucun suivi",
    tray_paused: "Paused" => "En pause",
    tray_tracking: "Tracking" => "Suivi en cours",
    tray_screenshots: " · screenshots on" => " · captures d’écran activées",
    menu_open: "Open RoundDigital Track" => "Ouvrir RoundDigital Track",
    menu_pause: "Pause / resume" => "Pause / reprise",
    menu_stop: "Stop session" => "Arrêter la session",
    menu_quit: "Quit (stops the session)" => "Quitter (arrête la session)",

    // Errors shown in the app.
    err_project_required: "Your organization requires a project for every session." => "Votre organisation exige un projet pour chaque session.",
    err_not_started: "The session did not start. Check the banner above or try again." => "La session n’a pas démarré. Consultez la bannière ci-dessus ou réessayez.",
    err_answered: "This was already answered." => "Cette question a déjà reçu une réponse.",
    err_reminder_answered: "This reminder was already answered." => "Ce rappel a déjà reçu une réponse.",
    err_choice_not_saved: "Your choice was not saved. Try again." => "Votre choix n’a pas été enregistré. Réessayez.",
    err_settings_not_saved: "Your settings were not saved. Try again." => "Vos paramètres n’ont pas été enregistrés. Réessayez.",
    err_server_https: "Enter the server address starting with https://" => "Entrez l’adresse du serveur, en commençant par https://",
    setup_key_invalid: "This computer's setup from your IT team is no longer valid. Ask them, or use a code from your administrator." => "La configuration de cet ordinateur par votre équipe des TI n’est plus valide. Adressez-vous à elle, ou utilisez un code de votre administrateur.",
    setup_enter_email: "Enter your work email address." => "Entrez votre adresse courriel professionnelle.",
    setup_cant_reach: "Can't reach {server}. Check your connection and try again." => "Impossible de joindre {server}. Vérifiez votre connexion et réessayez.",
    setup_too_many: "Too many tries. Wait a minute, then ask again." => "Trop d’essais. Attendez une minute, puis redemandez.",
    setup_code_failed: "Couldn't ask for a code: {error}" => "Impossible de demander un code : {error}",
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placeholders(s: &str) -> Vec<String> {
        let mut out: Vec<String> = s
            .split('{')
            .skip(1)
            .filter_map(|p| p.split_once('}').map(|(name, _)| name.to_owned()))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn every_language_fills_the_same_placeholders() {
        for (name, en, fr) in ALL {
            assert!(!fr.is_empty(), "{name}");
            assert_eq!(placeholders(en), placeholders(fr), "{name}");
        }
    }

    #[test]
    fn languages_from_tags_and_formats() {
        assert_eq!(Lang::from_tag("fr-CA"), Lang::Fr);
        assert_eq!(Lang::from_tag("fr_FR.UTF-8"), Lang::Fr);
        assert_eq!(Lang::from_tag("en-GB"), Lang::En);
        assert_eq!(Lang::from_tag("de-DE"), Lang::En);
        assert_eq!(Lang::Fr.day_month(29, 10), "29 oct.");
        assert_eq!(Lang::En.day_month(2, 11), "2 Nov");
        assert_eq!(Lang::Fr.percent(71), "71\u{a0}%");
        assert_eq!(
            fill(EN.idle_title, &[("duration", "28 min")]),
            "You were away for 28 min"
        );
    }
}
