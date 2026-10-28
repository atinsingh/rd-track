// Popover UI of the RoundDigital Track tray app. Plain DOM, no framework, no network:
// everything comes from the Rust side through `invoke` (allow-listed commands) and
// the `view` event. All server-provided strings are set with textContent.

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> };
}
declare global {
  interface Window {
    __TAURI__: TauriGlobal;
  }
}

interface BannerAction { label: string; command: string; arg: string | null }
interface Banner { id: string; kind: "info" | "warn"; text: string; action: BannerAction | null; dismissible: boolean }
interface Task { id: string; name: string }
interface Project { id: string; name: string; tasks: Task[] }
interface AppView {
  phase: "enroll" | "starting" | "running" | "stopping" | "revoked" | "error";
  error: string | null;
  tray: "idle" | "tracking" | "paused";
  label: string;
  elapsed: string | null;
  session_project_id: string | null;
  session_task_id: string | null;
  camera: string | null;
  today: string;
  activity: string | null;
  sync: string;
  banners: Banner[];
  can_start: boolean;
  require_project: boolean;
  projects: Project[];
  projects_supported: boolean | null;
  server_url: string | null;
  simulated: boolean;
  version: string;
}
interface Item { key: string; collected: boolean; text: string; detail: string }
interface SessionNotice {
  project_id: string | null;
  task_id: string | null;
  title: string;
  items: Item[];
  not_collected: Item[];
  footer: string[];
  never: string;
  warning: string | null;
}

const tauri = window.__TAURI__;
const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  tauri.core.invoke<T>(cmd, args);

let view: AppView | null = null;
let notice: { data: SessionNotice; review: boolean } | null = null;
let selectedProject = "";
let selectedTask = "";
let busy = false;
let error: string | null = null;
let projectsRequested = false;
const enrollForm = { server: "", code: "", name: "" };

// ----- tiny DOM helper ------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k in el && k !== "list") {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function cameraIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "#FFFFFF", "stroke-width": "2", "aria-hidden": "true" })) {
    svg.setAttribute(k, v);
  }
  const rect = document.createElementNS(SVG_NS, "rect");
  for (const [k, v] of Object.entries({ x: "3", y: "7", width: "18", height: "13", rx: "2" })) rect.setAttribute(k, v);
  const circle = document.createElementNS(SVG_NS, "circle");
  for (const [k, v] of Object.entries({ cx: "12", cy: "13.5", r: "3.5" })) circle.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M9 7l1.5-3h3L15 7");
  svg.append(rect, circle, path);
  return svg;
}

// ----- actions ------------------------------------------------------------------------

async function run(fn: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  error = null;
  render();
  try {
    await fn();
  } catch (e) {
    error = typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong";
  } finally {
    busy = false;
    render();
  }
}

async function refresh(): Promise<void> {
  view = await invoke<AppView>("get_view");
  render();
}

function loadProjects(): void {
  if (projectsRequested || !view || view.phase !== "running") return;
  projectsRequested = true;
  invoke<AppView>("list_projects")
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

const opt = (s: string): string | null => (s === "" ? null : s);

function onStart(): void {
  void run(async () => {
    const data = await invoke<SessionNotice>("prepare_session", {
      projectId: opt(selectedProject),
      taskId: opt(selectedTask),
    });
    notice = { data, review: false };
  });
}

function onConfirmStart(): void {
  if (!notice) return;
  const { project_id, task_id } = notice.data;
  void run(async () => {
    view = await invoke<AppView>("start_session", { projectId: project_id, taskId: task_id });
    notice = null;
  });
}

function onBannerAction(b: Banner): void {
  const a = b.action;
  if (!a) return;
  void run(async () => {
    if (a.command === "review_collection") {
      notice = { data: await invoke<SessionNotice>("review_collection"), review: true };
    } else if (a.command === "request_permission" || a.command === "open_permission_settings") {
      await invoke(a.command, { name: a.arg });
    } else if (a.command === "install_update") {
      await invoke("install_update");
    }
    await refresh();
  });
}

// ----- views --------------------------------------------------------------------------

function banners(v: AppView): Node[] {
  return v.banners.map((b) =>
    h(
      "div",
      { class: `banner ${b.kind}`, role: b.kind === "warn" ? "alert" : "status" },
      h("span", {}, b.text),
      (b.action || b.dismissible) &&
        h(
          "div",
          { class: "row" },
          b.dismissible &&
            h("button", {
              class: "x",
              type: "button",
              onclick: () => void run(() => invoke("dismiss_banner", { id: b.id })),
            }, "DISMISS"),
          b.action &&
            h("button", { class: "act", type: "button", onclick: () => onBannerAction(b) }, b.action.label),
        ),
    ),
  );
}

function header(v: AppView): HTMLElement {
  const dotClass = v.tray === "tracking" ? "dot" : `dot ${v.tray}`;
  return h(
    "div",
    { class: "head" },
    h(
      "span",
      { class: "brand" },
      h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" }),
      h("span", { class: "status" }, h("span", { class: dotClass, "aria-hidden": "true" }), v.label),
    ),
    v.elapsed && h("span", { class: "elapsed", "aria-label": "Elapsed" }, v.elapsed),
  );
}

function projectPickers(v: AppView): Node[] {
  const open = v.tray !== "idle";
  const projectValue = open ? v.session_project_id ?? "" : selectedProject;
  const taskValue = open ? v.session_task_id ?? "" : selectedTask;
  const project = v.projects.find((p) => p.id === projectValue);
  const projectSelect = h(
    "select",
    {
      disabled: open || busy,
      onchange: (e: Event) => {
        selectedProject = (e.target as HTMLSelectElement).value;
        selectedTask = "";
        render();
      },
    },
    h("option", { value: "" }, v.require_project ? "Choose a project…" : "No project"),
    ...v.projects.map((p) => h("option", { value: p.id }, p.name)),
  );
  // A recovered session's project may not be in the list (yet): still show it.
  if (projectValue && !project) projectSelect.append(h("option", { value: projectValue }, projectValue));
  projectSelect.value = projectValue;
  const tasks = project?.tasks ?? [];
  const taskSelect = h(
    "select",
    {
      disabled: open || busy || tasks.length === 0,
      onchange: (e: Event) => {
        selectedTask = (e.target as HTMLSelectElement).value;
      },
    },
    h("option", { value: "" }, tasks.length ? "No task" : "—"),
    ...tasks.map((t) => h("option", { value: t.id }, t.name)),
  );
  if (taskValue && !tasks.some((t) => t.id === taskValue)) taskSelect.append(h("option", { value: taskValue }, taskValue));
  taskSelect.value = taskValue;
  const out: Node[] = [
    h("label", { class: "field" }, "Project", projectSelect),
    h("label", { class: "field" }, "Task", taskSelect),
  ];
  if (v.projects_supported === false) {
    out.push(h("p", { class: "hint" }, "Your server does not list projects for this app yet. Sessions start without a project."));
  }
  return out;
}

function sessionButtons(v: AppView): HTMLElement {
  if (v.tray === "idle") {
    const blocked = !v.can_start || busy || (v.require_project && !selectedProject);
    return h(
      "div",
      { class: "actions one" },
      h("button", { class: "btn-action", type: "button", disabled: blocked, onclick: onStart }, "Start session"),
    );
  }
  const paused = v.tray === "paused";
  return h(
    "div",
    { class: "actions" },
    h(
      "button",
      {
        class: "btn-outline-light",
        type: "button",
        disabled: busy,
        onclick: () => void run(() => invoke(paused ? "resume_session" : "pause_session")),
      },
      paused ? "Resume" : "Pause",
    ),
    h(
      "button",
      { class: "btn-solid-light", type: "button", disabled: busy, onclick: () => void run(() => invoke("stop_session")) },
      "Stop",
    ),
  );
}

function mainView(v: AppView): HTMLElement {
  loadProjects();
  return h(
    "section",
    { class: "popover", "aria-label": "RoundDigital Track" },
    header(v),
    ...banners(v),
    v.camera && h("div", { class: "badge" }, cameraIcon(), v.camera),
    ...projectPickers(v),
    sessionButtons(v),
    error && h("p", { class: "error", role: "alert" }, error),
    h(
      "div",
      { class: "today" },
      h("span", { class: "label" }, "Today"),
      h(
        "span",
        { class: "value" },
        h("span", { class: "mono" }, v.today),
        v.activity ? " · activity " : "",
        v.activity ? h("span", { class: "mono" }, v.activity) : "",
      ),
    ),
    h(
      "div",
      { class: "foot" },
      h("span", {}, v.sync),
      h("button", { class: "link", type: "button", onclick: () => void run(() => invoke("open_dashboard")) }, "My dashboard →"),
    ),
    h(
      "div",
      { class: "small-links" },
      h("span", { class: "hint" }, `v${v.version}`),
      h("button", { class: "link", type: "button", onclick: () => void invoke("quit_app") }, v.tray === "idle" ? "Quit" : "Stop & quit"),
    ),
  );
}

function noticeView(n: SessionNotice, review: boolean): HTMLElement {
  const screenshots = (i: Item): boolean => i.key === "screenshots.enabled";
  return h(
    "section",
    { class: "notice", "aria-labelledby": "notice-h" },
    h("span", { class: "eyebrow" }, review ? "What changed" : "Before you start"),
    h("h2", { id: "notice-h" }, review ? "This session now collects" : n.title),
    h("p", { class: "lead" }, "While this session runs, RoundDigital Track records:"),
    h(
      "ul",
      {},
      ...n.items.map((i) =>
        h("li", { class: screenshots(i) ? "strong" : "" }, h("span", { class: "text" }, i.text), h("span", { class: "detail" }, i.detail)),
      ),
    ),
    n.warning && h("p", { class: "warnline", role: "note" }, n.warning),
    ...n.footer.map((f) => h("p", { class: "fine" }, f)),
    n.not_collected.length > 0 &&
      h(
        "details",
        {},
        h("summary", {}, "Not collected"),
        h("ul", {}, ...n.not_collected.map((i) => h("li", {}, i.text))),
        h("p", {}, `Never: ${n.never}`),
      ),
    error && h("p", { class: "warnline", role: "alert" }, error),
    h("div", { class: review ? "buttons one" : "buttons" }, ...noticeButtons(review)),
  );
}

function noticeButtons(review: boolean): HTMLElement[] {
  const close = (): void => {
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

function enrollView(v: AppView): HTMLElement {
  const input = (key: keyof typeof enrollForm, label: string, attrs: Record<string, unknown>): HTMLElement =>
    h(
      "label",
      { class: "field" },
      label,
      h("input", {
        value: enrollForm[key],
        oninput: (e: Event) => {
          enrollForm[key] = (e.target as HTMLInputElement).value;
        },
        disabled: busy,
        ...attrs,
      }),
    );
  return h(
    "form",
    {
      class: "popover",
      onsubmit: (e: Event) => {
        e.preventDefault();
        void run(async () => {
          view = await invoke<AppView>("enroll", {
            serverUrl: enrollForm.server,
            code: enrollForm.code,
            deviceName: opt(enrollForm.name.trim()),
          });
          enrollForm.code = "";
        });
      },
    },
    h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })),
    h("span", { class: "eyebrow" }, "Set up this computer"),
    h("h1", { class: "title" }, "Connect to your organization"),
    h("p", { class: "muted" }, "Your administrator gives you a server address and a one-time code. Nothing is recorded until you start a session."),
    v.phase === "error" && v.error && h("p", { class: "error", role: "alert" }, v.error),
    input("server", "Server address", { type: "url", placeholder: "https://track.example.com", required: true, autocomplete: "url", spellcheck: false }),
    input("code", "Enrollment code", { placeholder: "ABCDEFGHJK", required: true, autocomplete: "one-time-code", spellcheck: false }),
    input("name", "Device name (optional)", { placeholder: "Defaults to this computer's name" }),
    error && h("p", { class: "error", role: "alert" }, error),
    h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "submit", disabled: busy }, busy ? "Connecting…" : "Connect")),
  );
}

function revokedView(): HTMLElement {
  return h(
    "section",
    { class: "popover" },
    h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })),
    h("span", { class: "eyebrow" }, "Device removed"),
    h("h1", { class: "title" }, "Tracking has stopped"),
    h("p", { class: "muted" }, "Your organization removed this computer. Nothing is recorded and data that had not been sent was erased from this computer."),
    h("div", { class: "actions one" }, h("button", { class: "btn-action", type: "button", onclick: () => void run(async () => { view = await invoke<AppView>("reenroll"); }) }, "Enroll again")),
    h("div", { class: "small-links" }, h("span", {}), h("button", { class: "link", type: "button", onclick: () => void invoke("quit_app") }, "Quit")),
  );
}

function simpleView(text: string): HTMLElement {
  return h("section", { class: "popover" }, h("span", { class: "brand" }, h("img", { src: "img/rd-logo-reversed.png", alt: "RoundDigital Track" })), h("p", { class: "muted" }, text));
}

function render(): void {
  const root = document.getElementById("app");
  if (!root) return;
  const v = view;
  let content: HTMLElement;
  if (!v) content = simpleView("Starting…");
  else if (notice) content = noticeView(notice.data, notice.review);
  else if (v.phase === "enroll" || (v.phase === "error" && !v.server_url)) content = enrollView(v);
  else if (v.phase === "revoked") content = revokedView();
  else if (v.phase === "error") content = simpleView(v.error ?? "The agent could not start.");
  else if (v.phase === "starting") content = simpleView("Starting…");
  else if (v.phase === "stopping") content = simpleView("Stopping the session and sending the last data…");
  else content = mainView(v);
  document.body.classList.toggle("light", notice !== null);
  // Keep focus and the select values stable across re-renders.
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active?.closest("label")?.textContent ?? null;
  root.replaceChildren(content);
  if (focusKey) {
    for (const l of root.querySelectorAll("label")) {
      if (l.textContent === focusKey) (l.querySelector("input,select") as HTMLElement | null)?.focus();
    }
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (notice) {
      notice = null;
      render();
    } else void invoke("hide_window");
  }
});

void tauri.event.listen<AppView>("view", (e) => {
  view = e.payload;
  // Re-rendering while the employee types or picks would fight their input; the
  // 1 Hz view only needs to repaint the passive parts, so skip while a field is focused.
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT") return;
  render();
});
void refresh();

export {};
