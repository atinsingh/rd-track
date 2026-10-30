// Popover UI of the RoundDigital Track tray app. Plain DOM, no framework, no network:
// everything comes from the Rust side through `invoke` (allow-listed commands) and
// the `view` event. All server-provided strings are set with textContent.
import { browserLang, setLang, t } from "./i18n.js";
const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
let view = null;
let notice = null;
let selectedProject = "";
let selectedTask = "";
let busy = false;
let error = null;
let projectsRequested = false;
// The "Reminders" settings section is open, and its last save error.
let settingsOpen = false;
// "Open when I sign in" (G10): read when the settings open; null until then.
let openAtLogin = null;
let settingsError = null;
// Shown under the start button when "Start tracking" needs a project first.
let startHint = null;
const enrollForm = { server: "", code: "", name: "" };
// The enrolment link last applied to the form, so typing over it isn't undone on the next view.
let appliedLink = "";
let fromLink = false;
// IT deployed this computer (G26): connect with a work email and an emailed code.
const managed = { step: "email", email: "", useAdminCode: false };
/** "rdtrack://enroll?server=…&code=…" pasted into the code field fills in both fields. */
function linkParts(text) {
    const t = text.trim();
    if (!t.startsWith("rdtrack://"))
        return null;
    try {
        const u = new URL(t);
        const server = u.searchParams.get("server") ?? "";
        const code = u.searchParams.get("code") ?? "";
        return u.hostname === "enroll" && server && code ? { server: server.replace(/\/$/, ""), code } : null;
    }
    catch {
        return null;
    }
}
// The person's pending choice on the idle-return panel (reset for each new prompt).
const idleChoice = {
    id: "",
    decision: "keep",
    project: "",
    task: "",
};
function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false)
            continue;
        if (k === "class")
            el.className = String(v);
        else if (k.startsWith("on") && typeof v === "function") {
            el.addEventListener(k.slice(2), v);
        }
        else if (k in el && k !== "list") {
            el[k] = v;
        }
        else
            el.setAttribute(k, String(v));
    }
    for (const c of children) {
        if (c === null || c === undefined || c === false)
            continue;
        el.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function cameraIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({ width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "#FFFFFF", "stroke-width": "2", "aria-hidden": "true" })) {
        svg.setAttribute(k, v);
    }
    const rect = document.createElementNS(SVG_NS, "rect");
    for (const [k, v] of Object.entries({ x: "3", y: "7", width: "18", height: "13", rx: "2" }))
        rect.setAttribute(k, v);
    const circle = document.createElementNS(SVG_NS, "circle");
    for (const [k, v] of Object.entries({ cx: "12", cy: "13.5", r: "3.5" }))
        circle.setAttribute(k, v);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M9 7l1.5-3h3L15 7");
    svg.append(rect, circle, path);
    return svg;
}
// ----- actions ------------------------------------------------------------------------
async function run(fn) {
    if (busy)
        return;
    busy = true;
    error = null;
    render();
    try {
        await fn();
    }
    catch (e) {
        error = typeof e === "string" ? e : e instanceof Error ? e.message : t("error.generic");
    }
    finally {
        busy = false;
        render();
    }
}
async function refresh() {
    view = await invoke("get_view");
    render();
}
function loadProjects() {
    if (projectsRequested || !view || view.phase !== "running")
        return;
    projectsRequested = true;
    invoke("list_projects")
        .then((v) => {
        view = v;
        render();
    })
        .catch((e) => {
        projectsRequested = false;
        error = String(e);
        render();
    });
}
const opt = (s) => (s === "" ? null : s);
async function prepareStart() {
    const data = await invoke("prepare_session", {
        projectId: opt(selectedProject),
        taskId: opt(selectedTask),
    });
    notice = { data, review: false };
}
function onStart() {
    startHint = null;
    void run(prepareStart);
}
// A reminder's buttons. "Start tracking" continues into the same flow as the Start
// button (project picker, then the session-start notice).
function onReminder(r, choice) {
    void run(async () => {
        view = await invoke("resolve_reminder", { id: r.id, choice });
        if (choice !== "start")
            return;
        if (!view.can_start)
            return;
        if (view.require_project && !selectedProject) {
            startHint = t("pick.startHint");
            return;
        }
        await prepareStart();
    });
}
function saveReminders(change) {
    if (!view)
        return;
    const r = view.reminders;
    const settings = {
        enabled: r.enabled,
        start: r.start,
        stop: r.stop,
        still_tracking: r.still_tracking,
        my_start: r.my_start,
        my_end: r.my_end,
        my_days: r.my_days,
        ...change,
    };
    settingsError = null;
    invoke("set_reminder_settings", { settings })
        .then((v) => {
        view = v;
    })
        .catch((e) => {
        settingsError = String(e);
    })
        .finally(render);
}
function onConfirmStart() {
    if (!notice)
        return;
    const { project_id, task_id } = notice.data;
    void run(async () => {
        view = await invoke("start_session", { projectId: project_id, taskId: task_id });
        notice = null;
    });
}
function onBannerAction(b) {
    const a = b.action;
    if (!a)
        return;
    void run(async () => {
        if (a.command === "review_collection") {
            notice = { data: await invoke("review_collection"), review: true };
        }
        else if (a.command === "request_permission" || a.command === "open_permission_settings") {
            await invoke(a.command, { name: a.arg });
        }
        else if (a.command === "install_update") {
            await invoke("install_update");
        }
        else if (a.command === "dismiss_banner") {
            await invoke("dismiss_banner", { id: a.arg });
        }
        await refresh();
    });
}
// ----- views --------------------------------------------------------------------------
function banners(v) {
    return v.banners.map((b) => h("div", { class: `banner ${b.kind}`, role: b.kind === "warn" ? "alert" : "status" }, b.detail ? h("strong", { class: "banner-title" }, b.text) : h("span", {}, b.text), b.detail && h("span", { class: "banner-detail" }, b.detail), (b.action || b.dismissible) &&
        h("div", { class: "row" }, b.dismissible &&
            h("button", {
                class: "x",
                type: "button",
                onclick: () => void run(() => invoke("dismiss_banner", { id: b.id })),
            }, t("banner.dismiss")), b.action &&
            h("button", { class: "act", type: "button", onclick: () => onBannerAction(b) }, b.action.label))));
}
function header(v) {
    const dotClass = v.tray === "tracking" ? "dot" : `dot ${v.tray}`;
    return h("div", { class: "head" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" }), h("span", { class: "status" }, h("span", { class: dotClass, "aria-hidden": "true" }), v.label)), v.elapsed && h("span", { class: "elapsed", "aria-label": t("head.elapsed") }, v.elapsed));
}
function projectPickers(v) {
    const open = v.tray !== "idle";
    const projectValue = open ? v.session_project_id ?? "" : selectedProject;
    const taskValue = open ? v.session_task_id ?? "" : selectedTask;
    const project = v.projects.find((p) => p.id === projectValue);
    const projectSelect = h("select", {
        disabled: open || busy,
        onchange: (e) => {
            selectedProject = e.target.value;
            selectedTask = "";
            render();
        },
    }, h("option", { value: "" }, v.require_project ? t("pick.chooseProject") : t("pick.noProject")), ...v.projects.map((p) => h("option", { value: p.id }, p.name)));
    // A recovered session's project may not be in the list (yet): still show it.
    if (projectValue && !project)
        projectSelect.append(h("option", { value: projectValue }, projectValue));
    projectSelect.value = projectValue;
    const tasks = project?.tasks ?? [];
    const taskSelect = h("select", {
        disabled: open || busy || tasks.length === 0,
        onchange: (e) => {
            selectedTask = e.target.value;
        },
    }, h("option", { value: "" }, tasks.length ? t("pick.noTask") : "—"), ...tasks.map((task) => h("option", { value: task.id }, task.name)));
    if (taskValue && !tasks.some((task) => task.id === taskValue))
        taskSelect.append(h("option", { value: taskValue }, taskValue));
    taskSelect.value = taskValue;
    const out = [
        h("label", { class: "field" }, t("pick.project"), projectSelect),
        h("label", { class: "field" }, t("pick.task"), taskSelect),
    ];
    if (v.projects_supported === false) {
        out.push(h("p", { class: "hint" }, t("pick.unsupported")));
    }
    return out;
}
function sessionButtons(v) {
    if (v.tray === "idle") {
        const blocked = !v.can_start || busy || (v.require_project && !selectedProject);
        return h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", disabled: blocked, onclick: onStart }, t("session.start")));
    }
    const paused = v.tray === "paused";
    return h("div", { class: "actions" }, h("button", {
        class: "btn-outline-light",
        type: "button",
        disabled: busy,
        onclick: () => void run(() => invoke(paused ? "resume_session" : "pause_session")),
    }, paused ? t("session.resume") : t("session.pause")), h("button", { class: "btn-solid-light", type: "button", disabled: busy, onclick: () => void run(() => invoke("stop_session")) }, t("session.stop")));
}
// A start / stop / "still tracking?" reminder: title, one line, two buttons.
function reminderCard(r) {
    return h("div", { class: "banner info reminder", role: "status" }, h("strong", { class: "banner-title" }, r.title), h("span", { class: "banner-detail" }, r.detail), h("div", { class: "row" }, h("button", { class: "x", type: "button", disabled: busy, onclick: () => onReminder(r, r.secondary.choice) }, r.secondary.label), h("button", { class: "act", type: "button", disabled: busy, onclick: () => onReminder(r, r.primary.choice) }, r.primary.label)));
}
const WEEKDAYS = [[1, "day.mon"], [2, "day.tue"], [3, "day.wed"], [4, "day.thu"], [5, "day.fri"], [6, "day.sat"], [7, "day.sun"]];
// "Reminders": employee-controlled, kept on this computer only.
function remindersSection(v) {
    const r = v.reminders;
    const toggle = (label, checked, disabled, change) => h("label", { class: `toggle${disabled ? " disabled" : ""}` }, h("input", {
        type: "checkbox",
        checked,
        disabled,
        onchange: (e) => saveReminders(change(e.target.checked)),
    }), h("span", {}, label));
    const off = !r.enabled;
    const hours = r.schedule_note
        ? [h("p", { class: "hint" }, r.schedule_note)]
        : [
            h("div", { class: "hours" }, h("label", { class: "field" }, t("settings.start"), h("input", { type: "time", value: r.my_start, disabled: off, onchange: (e) => saveReminders({ my_start: e.target.value }) })), h("label", { class: "field" }, t("settings.end"), h("input", { type: "time", value: r.my_end, disabled: off, onchange: (e) => saveReminders({ my_end: e.target.value }) }))),
            h("fieldset", { class: "days" }, h("legend", { class: "sr-only" }, t("settings.workdays")), ...WEEKDAYS.map(([d, name]) => h("label", { class: `day${r.my_days.includes(d) ? " on" : ""}` }, h("input", {
                type: "checkbox",
                checked: r.my_days.includes(d),
                disabled: off,
                onchange: (e) => {
                    const on = e.target.checked;
                    saveReminders({ my_days: on ? [...r.my_days, d] : r.my_days.filter((x) => x !== d) });
                },
            }), h("span", {}, t(name))))),
        ];
    return h("section", { class: "settings", "aria-label": t("settings.label") }, h("span", { class: "eyebrow", id: "reminders-h" }, t("settings.reminders")), toggle(t("settings.remindersToggle"), r.enabled, false, (on) => ({ enabled: on })), toggle(t("settings.whenStart"), r.start, off, (on) => ({ start: on })), toggle(t("settings.whenEnd"), r.stop, off, (on) => ({ stop: on })), toggle(t("settings.everyHour"), r.still_tracking, off, (on) => ({ still_tracking: on })), h("span", { class: "label" }, t("settings.myHours")), ...hours, h("p", { class: "hint" }, t("settings.localOnly", { today: r.today })), h("span", { class: "eyebrow" }, t("settings.thisComputer")), h("label", { class: `toggle${openAtLogin === null ? " disabled" : ""}` }, h("input", {
        type: "checkbox",
        checked: openAtLogin === true,
        disabled: openAtLogin === null,
        onchange: (e) => {
            const enabled = e.target.checked;
            settingsError = null;
            invoke("set_open_at_login", { enabled })
                .then((on) => {
                openAtLogin = on;
            })
                .catch((err) => {
                settingsError = String(err);
            })
                .finally(render);
        },
    }), h("span", {}, t("settings.openAtLogin"))), h("p", { class: "hint" }, t("settings.openAtLoginHint")), settingsError && h("p", { class: "error", role: "alert" }, settingsError));
}
function onResolveIdle(iv) {
    const move = idleChoice.decision === "reassign";
    void run(async () => {
        view = await invoke("resolve_idle", {
            id: iv.id,
            decision: idleChoice.decision,
            projectId: move ? opt(idleChoice.project) : null,
            taskId: move ? opt(idleChoice.task) : null,
        });
    });
}
// "Welcome back": what should happen to the idle run the person just came back from.
// Only they can answer; tracking carries on whatever they pick.
function idleView(v, iv) {
    if (idleChoice.id !== iv.id) {
        Object.assign(idleChoice, { id: iv.id, decision: "keep", project: "", task: "" });
        error = null;
    }
    const canMove = iv.targets.length > 0;
    const choice = (value, text, enabled = true) => {
        const on = idleChoice.decision === value;
        return h("label", { class: `choice${on ? " on" : ""}${enabled ? "" : " disabled"}` }, h("input", {
            type: "radio",
            name: "idle-choice",
            value,
            checked: on,
            disabled: busy || !enabled,
            onchange: () => {
                idleChoice.decision = value;
                error = null;
                render();
            },
        }), h("span", {}, text));
    };
    const move = idleChoice.decision === "reassign";
    const target = iv.targets.find((p) => p.id === idleChoice.project);
    const tasks = target?.tasks ?? [];
    const picker = [];
    if (move) {
        const projectSelect = h("select", {
            disabled: busy,
            onchange: (e) => {
                idleChoice.project = e.target.value;
                idleChoice.task = "";
                render();
            },
        }, h("option", { value: "" }, t("pick.chooseProject")), ...iv.targets.map((p) => h("option", { value: p.id }, p.name)));
        projectSelect.value = idleChoice.project;
        picker.push(h("label", { class: "field" }, t("pick.project"), projectSelect));
        if (tasks.length > 0) {
            const taskSelect = h("select", {
                disabled: busy,
                onchange: (e) => {
                    idleChoice.task = e.target.value;
                },
            }, h("option", { value: "" }, t("pick.noTask")), ...tasks.map((task) => h("option", { value: task.id }, task.name)));
            taskSelect.value = idleChoice.task;
            picker.push(h("label", { class: "field" }, t("pick.task"), taskSelect));
        }
        picker.push(h("p", { class: "hint" }, t("idle.correction")));
    }
    const primary = idleChoice.decision === "keep" ? iv.keep_label : idleChoice.decision === "discard" ? iv.discard_label : iv.reassign_label;
    return h("section", { class: "popover", "aria-labelledby": "idle-h" }, header(v), h("div", { class: "idle-panel" }, h("span", { class: "eyebrow" }, t("idle.welcome")), h("h1", { class: "title", id: "idle-h" }, iv.title), h("p", { class: "idle-meta" }, h("span", { class: "mono" }, iv.times), " · ", iv.project), h("fieldset", { class: "choices" }, h("legend", { class: "sr-only" }, t("idle.question")), choice("keep", t("idle.keep")), choice("discard", t("idle.discard")), choice("reassign", t("idle.move"), canMove)), !canMove && h("p", { class: "hint" }, t("idle.noTarget")), ...picker, error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", disabled: busy || (move && !idleChoice.project), onclick: () => onResolveIdle(iv) }, primary)), h("p", { class: "idle-foot" }, t("idle.foot"))));
}
function mainView(v) {
    loadProjects();
    if (v.idle)
        return idleView(v, v.idle);
    return h("section", { class: "popover", "aria-label": "RoundDigital Track" }, header(v), v.reminder && reminderCard(v.reminder), ...banners(v), v.camera && h("div", { class: "badge" }, cameraIcon(), v.camera), ...projectPickers(v), sessionButtons(v), v.tray === "idle" && startHint && h("p", { class: "hint" }, startHint), error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "today" }, h("span", { class: "label" }, t("main.today")), h("span", { class: "value" }, h("span", { class: "mono" }, v.today), v.activity ? t("main.activity") : "", v.activity ? h("span", { class: "mono" }, v.activity) : "")), (v.limit_today || v.limit_week) &&
        h("div", { class: "limits" }, h("span", { class: "label" }, t("main.workLimit")), h("span", { class: "value" }, ...[v.limit_today, v.limit_week].filter((l) => !!l).map((l) => h("span", { class: "mono" }, l)))), h("div", { class: "foot" }, h("span", {}, v.sync), h("button", { class: "link", type: "button", onclick: () => void run(() => invoke("open_dashboard")) }, t("main.dashboard"))), settingsOpen && remindersSection(v), h("div", { class: "small-links" }, h("span", { class: "hint" }, `v${v.version}`), h("button", {
        class: "link",
        type: "button",
        "aria-expanded": String(settingsOpen),
        onclick: () => {
            settingsOpen = !settingsOpen;
            settingsError = null;
            if (settingsOpen)
                invoke("get_open_at_login")
                    .then((on) => {
                    openAtLogin = on;
                })
                    .catch(() => {
                    openAtLogin = null;
                })
                    .finally(render);
            render();
        },
    }, settingsOpen ? t("settings.close") : t("settings.open")), h("button", { class: "link", type: "button", onclick: () => void invoke("quit_app") }, v.tray === "idle" ? t("main.quit") : t("main.stopQuit"))));
}
function noticeView(n, review) {
    const screenshots = (i) => i.key === "screenshots.enabled";
    return h("section", { class: "notice", "aria-labelledby": "notice-h" }, h("span", { class: "eyebrow" }, review ? t("notice.whatChanged") : t("notice.beforeStart")), h("h2", { id: "notice-h" }, review ? t("notice.nowCollects") : n.title), h("p", { class: "lead" }, t("notice.lead")), h("ul", {}, ...n.items.map((i) => h("li", { class: screenshots(i) ? "strong" : "" }, h("span", { class: "text" }, i.text), h("span", { class: "detail" }, i.detail)))), n.warning && h("p", { class: "warnline", role: "note" }, n.warning), ...n.footer.map((f) => h("p", { class: "fine" }, f)), n.not_collected.length > 0 &&
        h("details", {}, h("summary", {}, t("notice.notCollected")), h("ul", {}, ...n.not_collected.map((i) => h("li", {}, i.text))), h("p", {}, t("notice.never", { list: n.never }))), error && h("p", { class: "warnline", role: "alert" }, error), h("div", { class: review ? "buttons one" : "buttons" }, ...noticeButtons(review)));
}
function noticeButtons(review) {
    const close = () => {
        notice = null;
        error = null;
        render();
    };
    if (review) {
        return [h("button", { class: "btn-action", type: "button", onclick: close }, t("notice.ok"))];
    }
    return [
        h("button", { class: "btn-outline-dark", type: "button", disabled: busy, onclick: close }, t("notice.otherProject")),
        h("button", { class: "btn-action", type: "button", disabled: busy, onclick: onConfirmStart }, t("notice.start")),
    ];
}
function managedEnrollView(v, server) {
    const field = (label, value, set, attrs) => h("label", { class: "field" }, label, h("input", { value, disabled: busy, oninput: (e) => set(e.target.value), ...attrs }));
    const askForCode = (e) => {
        e.preventDefault();
        void run(async () => {
            await invoke("request_email_code", { email: managed.email.trim() });
            managed.step = "code";
        });
    };
    const connect = (e) => {
        e.preventDefault();
        void run(async () => {
            view = await invoke("enroll", { serverUrl: server, code: enrollForm.code, deviceName: opt(enrollForm.name.trim()) });
            enrollForm.code = "";
        });
    };
    const other = h("div", { class: "small-links" }, managed.step === "code"
        ? h("button", { class: "link", type: "button", onclick: () => { managed.step = "email"; error = null; render(); } }, t("managed.again"))
        : h("span", {}), h("button", { class: "link", type: "button", onclick: () => { managed.useAdminCode = true; error = null; render(); } }, t("managed.adminCode")));
    const head = [
        h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })),
        h("span", { class: "eyebrow" }, t("enroll.setUp")),
    ];
    if (managed.step === "email")
        return h("form", { class: "popover", onsubmit: askForCode }, ...head, h("h1", { class: "title" }, t("managed.title")), h("p", { class: "muted" }, t("managed.intro", { server })), v.phase === "error" && v.error && h("p", { class: "error", role: "alert" }, v.error), field(t("managed.email"), managed.email, (s) => (managed.email = s), { type: "email", required: true, autocomplete: "email", spellcheck: false }), error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "submit", disabled: busy }, busy ? t("managed.sending") : t("managed.send"))), other);
    return h("form", { class: "popover", onsubmit: connect }, ...head, h("h1", { class: "title" }, t("managed.checkTitle")), h("p", { class: "muted" }, t("managed.checkIntro", { email: managed.email })), field(t("managed.code"), enrollForm.code, (s) => (enrollForm.code = s), { required: true, autocomplete: "one-time-code", spellcheck: false, placeholder: "ABCD-EFGH-JK" }), field(t("enroll.deviceName"), enrollForm.name, (s) => (enrollForm.name = s), { placeholder: t("enroll.deviceNamePlaceholder") }), error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "submit", disabled: busy }, busy ? t("enroll.connecting") : t("enroll.connect"))), other);
}
function enrollView(v) {
    if (v.deployment && !managed.useAdminCode)
        return managedEnrollView(v, v.deployment.server_url);
    const p = v.enroll_prefill;
    if (p && `${p.server_url} ${p.code}` !== appliedLink) {
        appliedLink = `${p.server_url} ${p.code}`;
        enrollForm.server = p.server_url;
        enrollForm.code = p.code;
        fromLink = true;
    }
    const input = (key, label, attrs) => h("label", { class: "field" }, label, h("input", {
        value: enrollForm[key],
        oninput: (e) => {
            const value = e.target.value;
            const parts = key === "code" ? linkParts(value) : null;
            if (parts) {
                enrollForm.server = parts.server;
                enrollForm.code = parts.code;
                fromLink = true;
                render();
                return;
            }
            enrollForm[key] = value;
        },
        disabled: busy,
        ...attrs,
    }));
    return h("form", {
        class: "popover",
        onsubmit: (e) => {
            e.preventDefault();
            void run(async () => {
                view = await invoke("enroll", {
                    serverUrl: enrollForm.server,
                    code: enrollForm.code,
                    deviceName: opt(enrollForm.name.trim()),
                });
                enrollForm.code = "";
            });
        },
    }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("span", { class: "eyebrow" }, t("enroll.setUp")), h("h1", { class: "title" }, t("enroll.title")), h("p", { class: "muted" }, t("enroll.intro")), fromLink && h("p", { class: "hint", role: "status" }, t("enroll.fromLink")), v.phase === "error" && v.error && h("p", { class: "error", role: "alert" }, v.error), input("server", t("enroll.server"), { type: "url", placeholder: "https://track.example.com", required: true, autocomplete: "url", spellcheck: false }), input("code", t("enroll.code"), { placeholder: t("enroll.codePlaceholder"), required: true, autocomplete: "one-time-code", spellcheck: false }), input("name", t("enroll.deviceName"), { placeholder: t("enroll.deviceNamePlaceholder") }), error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "submit", disabled: busy }, busy ? t("enroll.connecting") : t("enroll.connect"))));
}
function revokedView() {
    return h("section", { class: "popover" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("span", { class: "eyebrow" }, t("revoked.eyebrow")), h("h1", { class: "title" }, t("revoked.title")), h("p", { class: "muted" }, t("revoked.body")), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", onclick: () => void run(async () => { view = await invoke("reenroll"); }) }, t("revoked.again"))), h("div", { class: "small-links" }, h("span", {}), h("button", { class: "link", type: "button", onclick: () => void invoke("quit_app") }, t("main.quit"))));
}
function simpleView(text) {
    return h("section", { class: "popover" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("p", { class: "muted" }, text));
}
function render() {
    const root = document.getElementById("app");
    if (!root)
        return;
    const v = view;
    // The person's language from the Rust side; before the first view, the computer's (G27).
    setLang(v?.lang ?? browserLang());
    let content;
    if (!v)
        content = simpleView(t("app.starting"));
    else if (notice)
        content = noticeView(notice.data, notice.review);
    else if (v.phase === "enroll" || (v.phase === "error" && !v.server_url))
        content = enrollView(v);
    else if (v.phase === "revoked")
        content = revokedView();
    else if (v.phase === "error")
        content = simpleView(v.error ?? t("error.couldNotStart"));
    else if (v.phase === "starting")
        content = simpleView(t("app.starting"));
    else if (v.phase === "stopping")
        content = simpleView(t("app.stopping"));
    else
        content = mainView(v);
    document.body.classList.toggle("light", notice !== null);
    // Keep focus and the select values stable across re-renders.
    const active = document.activeElement;
    const focusKey = active?.closest("label")?.textContent ?? null;
    root.replaceChildren(content);
    if (focusKey) {
        for (const l of root.querySelectorAll("label")) {
            if (l.textContent === focusKey)
                l.querySelector("input,select")?.focus();
        }
    }
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (notice) {
            notice = null;
            render();
        }
        else
            void invoke("hide_window");
    }
});
void tauri.event.listen("view", (e) => {
    view = e.payload;
    // Re-rendering while the employee types or picks would fight their input; the
    // 1 Hz view only needs to repaint the passive parts, so skip while a field is focused.
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT")
        return;
    render();
});
void refresh();
