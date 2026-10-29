// Popover UI of the RoundDigital Track tray app. Plain DOM, no framework, no network:
// everything comes from the Rust side through `invoke` (allow-listed commands) and
// the `view` event. All server-provided strings are set with textContent.
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
let settingsError = null;
// Shown under the start button when "Start tracking" needs a project first.
let startHint = null;
const enrollForm = { server: "", code: "", name: "" };
// The enrolment link last applied to the form, so typing over it isn't undone on the next view.
let appliedLink = "";
let fromLink = false;
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
        error = typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong";
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
            startHint = "Choose a project, then start the session.";
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
            }, "DISMISS"), b.action &&
            h("button", { class: "act", type: "button", onclick: () => onBannerAction(b) }, b.action.label))));
}
function header(v) {
    const dotClass = v.tray === "tracking" ? "dot" : `dot ${v.tray}`;
    return h("div", { class: "head" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" }), h("span", { class: "status" }, h("span", { class: dotClass, "aria-hidden": "true" }), v.label)), v.elapsed && h("span", { class: "elapsed", "aria-label": "Elapsed" }, v.elapsed));
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
    }, h("option", { value: "" }, v.require_project ? "Choose a project…" : "No project"), ...v.projects.map((p) => h("option", { value: p.id }, p.name)));
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
    }, h("option", { value: "" }, tasks.length ? "No task" : "—"), ...tasks.map((t) => h("option", { value: t.id }, t.name)));
    if (taskValue && !tasks.some((t) => t.id === taskValue))
        taskSelect.append(h("option", { value: taskValue }, taskValue));
    taskSelect.value = taskValue;
    const out = [
        h("label", { class: "field" }, "Project", projectSelect),
        h("label", { class: "field" }, "Task", taskSelect),
    ];
    if (v.projects_supported === false) {
        out.push(h("p", { class: "hint" }, "Your server does not list projects for this app yet. Sessions start without a project."));
    }
    return out;
}
function sessionButtons(v) {
    if (v.tray === "idle") {
        const blocked = !v.can_start || busy || (v.require_project && !selectedProject);
        return h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", disabled: blocked, onclick: onStart }, "Start session"));
    }
    const paused = v.tray === "paused";
    return h("div", { class: "actions" }, h("button", {
        class: "btn-outline-light",
        type: "button",
        disabled: busy,
        onclick: () => void run(() => invoke(paused ? "resume_session" : "pause_session")),
    }, paused ? "Resume" : "Pause"), h("button", { class: "btn-solid-light", type: "button", disabled: busy, onclick: () => void run(() => invoke("stop_session")) }, "Stop"));
}
// A start / stop / "still tracking?" reminder: title, one line, two buttons.
function reminderCard(r) {
    return h("div", { class: "banner info reminder", role: "status" }, h("strong", { class: "banner-title" }, r.title), h("span", { class: "banner-detail" }, r.detail), h("div", { class: "row" }, h("button", { class: "x", type: "button", disabled: busy, onclick: () => onReminder(r, r.secondary.choice) }, r.secondary.label), h("button", { class: "act", type: "button", disabled: busy, onclick: () => onReminder(r, r.primary.choice) }, r.primary.label)));
}
const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
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
            h("div", { class: "hours" }, h("label", { class: "field" }, "Start", h("input", { type: "time", value: r.my_start, disabled: off, onchange: (e) => saveReminders({ my_start: e.target.value }) })), h("label", { class: "field" }, "End", h("input", { type: "time", value: r.my_end, disabled: off, onchange: (e) => saveReminders({ my_end: e.target.value }) }))),
            h("fieldset", { class: "days" }, h("legend", { class: "sr-only" }, "Workdays"), ...WEEKDAYS.map(([d, name]) => h("label", { class: `day${r.my_days.includes(d) ? " on" : ""}` }, h("input", {
                type: "checkbox",
                checked: r.my_days.includes(d),
                disabled: off,
                onchange: (e) => {
                    const on = e.target.checked;
                    saveReminders({ my_days: on ? [...r.my_days, d] : r.my_days.filter((x) => x !== d) });
                },
            }), h("span", {}, name)))),
        ];
    return h("section", { class: "settings", "aria-labelledby": "reminders-h" }, h("span", { class: "eyebrow", id: "reminders-h" }, "Reminders"), toggle("Reminders", r.enabled, false, (on) => ({ enabled: on })), toggle("When my hours start", r.start, off, (on) => ({ start: on })), toggle("When my hours end", r.stop, off, (on) => ({ stop: on })), toggle("Every hour after that, if still tracking", r.still_tracking, off, (on) => ({ still_tracking: on })), h("span", { class: "label" }, "My hours"), ...hours, h("p", { class: "hint" }, `${r.today}. Reminders stay on this computer; nothing is sent to your organization.`), settingsError && h("p", { class: "error", role: "alert" }, settingsError));
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
        }, h("option", { value: "" }, "Choose a project…"), ...iv.targets.map((p) => h("option", { value: p.id }, p.name)));
        projectSelect.value = idleChoice.project;
        picker.push(h("label", { class: "field" }, "Project", projectSelect));
        if (tasks.length > 0) {
            const taskSelect = h("select", {
                disabled: busy,
                onchange: (e) => {
                    idleChoice.task = e.target.value;
                },
            }, h("option", { value: "" }, "No task"), ...tasks.map((t) => h("option", { value: t.id }, t.name)));
            taskSelect.value = idleChoice.task;
            picker.push(h("label", { class: "field" }, "Task", taskSelect));
        }
        picker.push(h("p", { class: "hint" }, "Handled like any time correction: if your organisation reviews corrections, your manager approves it first."));
    }
    const primary = idleChoice.decision === "keep" ? iv.keep_label : idleChoice.decision === "discard" ? iv.discard_label : iv.reassign_label;
    return h("section", { class: "popover", "aria-labelledby": "idle-h" }, header(v), h("div", { class: "idle-panel" }, h("span", { class: "eyebrow" }, "Welcome back"), h("h1", { class: "title", id: "idle-h" }, iv.title), h("p", { class: "idle-meta" }, h("span", { class: "mono" }, iv.times), " · ", iv.project), h("fieldset", { class: "choices" }, h("legend", { class: "sr-only" }, "What should happen to this time?"), choice("keep", "Keep it as working time"), choice("discard", "Remove it"), choice("reassign", "Move it to another project", canMove)), !canMove && h("p", { class: "hint" }, "There is no other project to move it to."), ...picker, error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", disabled: busy || (move && !idleChoice.project), onclick: () => onResolveIdle(iv) }, primary)), h("p", { class: "idle-foot" }, "Your choice — your manager can't make it for you. Tracking carries on either way.")));
}
function mainView(v) {
    loadProjects();
    if (v.idle)
        return idleView(v, v.idle);
    return h("section", { class: "popover", "aria-label": "RoundDigital Track" }, header(v), v.reminder && reminderCard(v.reminder), ...banners(v), v.camera && h("div", { class: "badge" }, cameraIcon(), v.camera), ...projectPickers(v), sessionButtons(v), v.tray === "idle" && startHint && h("p", { class: "hint" }, startHint), error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "today" }, h("span", { class: "label" }, "Today"), h("span", { class: "value" }, h("span", { class: "mono" }, v.today), v.activity ? " · activity " : "", v.activity ? h("span", { class: "mono" }, v.activity) : "")), (v.limit_today || v.limit_week) &&
        h("div", { class: "limits" }, h("span", { class: "label" }, "Work limit"), h("span", { class: "value" }, ...[v.limit_today, v.limit_week].filter((l) => !!l).map((l) => h("span", { class: "mono" }, l)))), h("div", { class: "foot" }, h("span", {}, v.sync), h("button", { class: "link", type: "button", onclick: () => void run(() => invoke("open_dashboard")) }, "My dashboard →")), settingsOpen && remindersSection(v), h("div", { class: "small-links" }, h("span", { class: "hint" }, `v${v.version}`), h("button", {
        class: "link",
        type: "button",
        "aria-expanded": String(settingsOpen),
        onclick: () => {
            settingsOpen = !settingsOpen;
            settingsError = null;
            render();
        },
    }, settingsOpen ? "Close reminders" : "Reminders"), h("button", { class: "link", type: "button", onclick: () => void invoke("quit_app") }, v.tray === "idle" ? "Quit" : "Stop & quit")));
}
function noticeView(n, review) {
    const screenshots = (i) => i.key === "screenshots.enabled";
    return h("section", { class: "notice", "aria-labelledby": "notice-h" }, h("span", { class: "eyebrow" }, review ? "What changed" : "Before you start"), h("h2", { id: "notice-h" }, review ? "This session now collects" : n.title), h("p", { class: "lead" }, "While this session runs, RoundDigital Track records:"), h("ul", {}, ...n.items.map((i) => h("li", { class: screenshots(i) ? "strong" : "" }, h("span", { class: "text" }, i.text), h("span", { class: "detail" }, i.detail)))), n.warning && h("p", { class: "warnline", role: "note" }, n.warning), ...n.footer.map((f) => h("p", { class: "fine" }, f)), n.not_collected.length > 0 &&
        h("details", {}, h("summary", {}, "Not collected"), h("ul", {}, ...n.not_collected.map((i) => h("li", {}, i.text))), h("p", {}, `Never: ${n.never}`)), error && h("p", { class: "warnline", role: "alert" }, error), h("div", { class: review ? "buttons one" : "buttons" }, ...noticeButtons(review)));
}
function noticeButtons(review) {
    const close = () => {
        notice = null;
        error = null;
        render();
    };
    if (review) {
        return [h("button", { class: "btn-action", type: "button", onclick: close }, "OK")];
    }
    return [
        h("button", { class: "btn-outline-dark", type: "button", disabled: busy, onclick: close }, "Choose another project"),
        h("button", { class: "btn-action", type: "button", disabled: busy, onclick: onConfirmStart }, "Start session →"),
    ];
}
function enrollView(v) {
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
    }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("span", { class: "eyebrow" }, "Set up this computer"), h("h1", { class: "title" }, "Connect to your organization"), h("p", { class: "muted" }, "Use “Connect this computer” in Track on the web, or the server address and one-time code your administrator gave you. Nothing is recorded until you start a session."), fromLink && h("p", { class: "hint", role: "status" }, "Filled in from a link. Check the server address is your organization’s before you connect."), v.phase === "error" && v.error && h("p", { class: "error", role: "alert" }, v.error), input("server", "Server address", { type: "url", placeholder: "https://track.example.com", required: true, autocomplete: "url", spellcheck: false }), input("code", "Enrollment code", { placeholder: "ABCDEFGHJK, or paste the link", required: true, autocomplete: "one-time-code", spellcheck: false }), input("name", "Device name (optional)", { placeholder: "Defaults to this computer's name" }), error && h("p", { class: "error", role: "alert" }, error), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "submit", disabled: busy }, busy ? "Connecting…" : "Connect")));
}
function revokedView() {
    return h("section", { class: "popover" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("span", { class: "eyebrow" }, "Device removed"), h("h1", { class: "title" }, "Tracking has stopped"), h("p", { class: "muted" }, "Your organization removed this computer. Nothing is recorded and data that had not been sent was erased from this computer."), h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", onclick: () => void run(async () => { view = await invoke("reenroll"); }) }, "Enroll again")), h("div", { class: "small-links" }, h("span", {}), h("button", { class: "link", type: "button", onclick: () => void invoke("quit_app") }, "Quit")));
}
function simpleView(text) {
    return h("section", { class: "popover" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("p", { class: "muted" }, text));
}
function render() {
    const root = document.getElementById("app");
    if (!root)
        return;
    const v = view;
    let content;
    if (!v)
        content = simpleView("Starting…");
    else if (notice)
        content = noticeView(notice.data, notice.review);
    else if (v.phase === "enroll" || (v.phase === "error" && !v.server_url))
        content = enrollView(v);
    else if (v.phase === "revoked")
        content = revokedView();
    else if (v.phase === "error")
        content = simpleView(v.error ?? "The agent could not start.");
    else if (v.phase === "starting")
        content = simpleView("Starting…");
    else if (v.phase === "stopping")
        content = simpleView("Stopping the session and sending the last data…");
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
export {};
