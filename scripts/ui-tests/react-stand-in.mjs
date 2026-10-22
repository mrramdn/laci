// A stand-in for React that draws Simple's pages in plain Node, so a test can click a button, press a
// key and look at what a page asks the engine for, without a browser. The same as the one in
// simple-ui.test.mjs, with what a page reads of an element besides: its id, and whether it is still
// on the page. Not a test itself: ui-state-smoke runs only *.test.mjs.
import assert from "node:assert/strict";
import { requireUi } from "../ui-module.mjs";

const { createElement, Fragment } = requireUi("react");

/** A drawn element: what a ref holds and what an event's target is. */
export class Host {
  constructor(page, type) {
    this.page = page;
    this.type = type;
    this.props = {};
    this.children = [];
    this.parent = null;
    this.pass = -1;
  }
  get textContent() {
    return this.children
      .map((child) => (child instanceof Host ? child.textContent : child))
      .join("");
  }
  get id() {
    return this.props.id ?? "";
  }
  /** Drawn in the last pass: an element that went away is not. */
  get isConnected() {
    return this.pass === this.page.passes();
  }
  /** Printed as its tag and its words, so that a failed comparison stays short. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `<${this.type}${this.props.id ? `#${this.props.id}` : ""}>${this.textContent}`;
  }
  /** Every element inside this one. */
  descendants() {
    return this.children.flatMap((child) =>
      child instanceof Host ? [child, ...child.descendants()] : [],
    );
  }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  // The page has no layout or styles: everything is shown, and nothing is hidden or inert.
  get offsetParent() {
    return this.parent ?? {};
  }
  closest() {
    return null;
  }
  matches() {
    return false;
  }
  querySelectorAll(selector) {
    return this.page.query(selector, this);
  }
  focus() {
    // As in a browser, a disabled control doesn't take the focus.
    if (this.props.disabled) return;
    this.page.document.activeElement = this;
    this.page.document.fire("focusin", { target: this });
  }
}

/**
 * An element in a few words, to compare: a failed assert prints what it compares in full, ignoring
 * the short form above, and an element leads to the whole page.
 */
export const describe = (host) =>
  host instanceof Host
    ? `<${host.type}${host.props["data-id"] ? ` ${host.props["data-id"]}` : ""}>${host.textContent}`
    : String(host);

/** A key press, or any event, with what an event has to say about where it goes. */
export const event = (extra) => ({
  defaultPrevented: false,
  stopped: false,
  isComposing: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.stopped = true;
  },
  ...extra,
});
export const keyEvent = (key, target, extra) => event({ key, target, ...extra });

/**
 * A page that components are drawn on, with React's hooks standing in for the real ones. State, refs
 * and effects keep their place between draws; an effect runs after the draw in which its inputs
 * changed (one without inputs after every draw), and its clean-up runs before it runs again or when
 * its component goes. A change to the state draws again in the next microtask, or at once inside
 * `act`.
 *
 * `query` answers `querySelectorAll`: the page has no selectors, so a test says which elements the
 * one selector it uses finds.
 */
export function standIn() {
  const listeners = [];
  const body = {};
  const document = {
    activeElement: null,
    body,
    getElementById: () => null,
    addEventListener: (type, handler, capture = false) =>
      void listeners.push({ type, handler, capture }),
    removeEventListener(type, handler, capture = false) {
      const at = listeners.findIndex(
        (l) => l.type === type && l.handler === handler && l.capture === capture,
      );
      if (at >= 0) listeners.splice(at, 1);
    },
    /** How many listeners wait for `type`. */
    waiting: (type) => listeners.filter((l) => l.type === type).length,
    /** Delivers an event as the browser does: the capturing listeners, then the others, unless stopped. */
    fire(type, ev) {
      for (const capture of [true, false]) {
        if (ev.stopped) break;
        for (const l of [...listeners])
          if (l.type === type && l.capture === capture) l.handler(ev);
      }
      return ev;
    },
  };
  const instances = new Map();
  const hosts = new Map();
  let root = null;
  let output = [];
  let current = null;
  let pass = 0;
  let ids = 0;
  let dirty = false;
  let queued = false;
  let layout = [];
  let passive = [];

  const page = { document, query: () => [], passes: () => pass };
  const schedule = () => {
    dirty = true;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      flush();
    });
  };
  const slot = () => (current.cells[current.at++] ??= {});
  const effect = (list) => (run, deps) => {
    const cell = slot();
    const same =
      cell.deps &&
      deps &&
      cell.deps.length === deps.length &&
      deps.every((dep, i) => Object.is(dep, cell.deps[i]));
    cell.deps = deps;
    if (!same) list().push({ cell, run });
  };
  const memo = (make, deps) => {
    const cell = slot();
    if (
      !cell.deps ||
      !deps ||
      deps.length !== cell.deps.length ||
      deps.some((dep, i) => !Object.is(dep, cell.deps[i]))
    ) {
      cell.value = make();
      cell.deps = deps;
    }
    return cell.value;
  };
  const react = {
    Fragment,
    useState(initial) {
      const cell = slot();
      if (!("value" in cell)) {
        cell.value = typeof initial === "function" ? initial() : initial;
        cell.set = (next) => {
          const value = typeof next === "function" ? next(cell.value) : next;
          if (Object.is(value, cell.value)) return;
          cell.value = value;
          schedule();
        };
      }
      return [cell.value, cell.set];
    },
    useRef(initial) {
      const cell = slot();
      return (cell.ref ??= { current: initial });
    },
    useId: () => (slot().id ??= `:r${++ids}:`),
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect: effect(() => passive),
    useLayoutEffect: effect(() => layout),
  };

  /** What an element draws, as hosts and text; a component is called, with its own place for hooks. */
  function render(element, path) {
    if (element === null || element === undefined || typeof element === "boolean")
      return [];
    if (typeof element === "string" || typeof element === "number")
      return [String(element)];
    if (Array.isArray(element))
      return element.flatMap((child, i) => render(child, `${path}[${child?.key ?? i}]`));
    const { type, props } = element;
    if (type === Fragment) return render(props.children, path);
    const key = `${path}/${typeof type === "function" ? type.name : type}${element.key ? `:${element.key}` : ""}`;
    if (typeof type === "function") {
      const instance = instances.get(key) ?? { cells: [] };
      instances.set(key, instance);
      instance.pass = pass;
      instance.at = 0;
      const outer = current;
      current = instance;
      const drawn = type(props);
      current = outer;
      return render(drawn, key);
    }
    const host = hosts.get(key) ?? new Host(page, type);
    hosts.set(key, host);
    host.pass = pass;
    host.props = props;
    host.children = render(props.children, key);
    for (const child of host.children) if (child instanceof Host) child.parent = host;
    if (typeof props.ref === "function") props.ref(host);
    else if (props.ref) props.ref.current = host;
    return [host];
  }
  function draw() {
    pass++;
    layout = [];
    passive = [];
    output = root ? render(root, "") : [];
    for (const [key, instance] of instances)
      if (instance.pass !== pass) {
        for (const cell of instance.cells) cell.cleanup?.();
        instances.delete(key);
      }
    for (const [key, host] of hosts)
      if (host.pass !== pass) {
        if (host.props.ref && typeof host.props.ref !== "function")
          host.props.ref.current = null;
        hosts.delete(key);
      }
    // As in a browser, the focus of an element that went away falls to the page.
    if (document.activeElement instanceof Host && !document.activeElement.isConnected)
      document.activeElement = body;
    for (const list of [layout, passive]) {
      for (const { cell } of list) {
        cell.cleanup?.();
        cell.cleanup = undefined;
      }
      for (const { cell, run } of list) {
        const cleanup = run();
        cell.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    }
  }
  function flush() {
    for (let turns = 0; dirty; turns++) {
      assert.ok(turns < 50, "the page never settles");
      dirty = false;
      draw();
    }
  }
  const all = (predicate) => {
    const found = [];
    const walk = (nodes) => {
      for (const node of nodes)
        if (node instanceof Host) {
          if (predicate(node)) found.push(node);
          walk(node.children);
        }
    };
    walk(output);
    return found;
  };
  return Object.assign(page, {
    react,
    /** A store the components read through a selector, as they read the app's: it draws again when it changes. */
    store(initial) {
      let state = initial;
      const use = (select = (s) => s) => select(state);
      use.getState = () => state;
      use.setState = (change) => {
        state = { ...state, ...(typeof change === "function" ? change(state) : change) };
        schedule();
      };
      return use;
    },
    /** Draws `element` as the page's one component. */
    mount(element) {
      root = element;
      dirty = true;
      flush();
      return page;
    },
    unmount() {
      root = null;
      dirty = true;
      flush();
    },
    /** Runs `work`, such as a click, and draws what it changed. */
    act(work) {
      const result = work();
      flush();
      return result;
    },
    /** Lets every promise that can settle, settle, and draws what it changed. */
    async settle() {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        flush();
      }
    },
    all,
    find: (predicate) => all(predicate)[0],
    /** The element with the focus, in a few words. */
    focused: () => describe(document.activeElement),
    /** The button that says `text`, or whose name is `text`. */
    button: (text) =>
      all(
        (n) =>
          n.type === "button" &&
          (n.textContent === text || n.props["aria-label"] === text),
      )[0],
    text: () => output.map((n) => (n instanceof Host ? n.textContent : n)).join(" "),
    /** Delivers a React event to an element and up through those around it, until one stops it. */
    dispatch(host, name, ev) {
      for (let at = host; at && !ev.stopped; at = at.parent) at.props[name]?.(ev);
      return ev;
    },
  });
}

/**
 * Simple's building blocks (ui/src/simple/ui) as plain elements a test can read and click: a button
 * says its kind in `data-kind`, a status its tone in `data-tone`; "Show details" shows what it holds,
 * and a ⋯ menu its items, as buttons. Pass the real `Countdown` to keep it.
 */
export function simpleBlocks(more = {}) {
  const tone = (tag) => ({ tone, children }) =>
    createElement(tag, { "data-tone": tone }, children);
  return {
    Button: ({ children, onClick, disabled, kind = "outline", className, ...rest }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick,
          className,
          disabled: Boolean(disabled),
          "data-kind": kind,
          "aria-label": rest["aria-label"],
        },
        children,
      ),
    Callout: tone("p"),
    StatusChip: tone("span"),
    Disclosure: ({ children, label = "Show details" }) =>
      createElement("div", { "data-disclosure": label }, children),
    EmptyState: ({ title, children, action }) =>
      createElement("div", { "data-empty": title }, title, " ", children, action),
    Info: ({ term }) => createElement("span", { "data-info": term }),
    MoreMenu: ({ label, items }) =>
      createElement(
        "div",
        { role: "menu", "aria-label": label },
        items
          .filter((item) => item !== "-")
          .map((item, i) =>
            createElement(
              "button",
              {
                key: i,
                type: "button",
                role: "menuitem",
                disabled: Boolean(item.disabled),
                onClick: item.onSelect,
              },
              item.label,
            ),
          ),
      ),
    ...more,
  };
}

/** A clock held at `now`: `Date.now()` and `new Date()` give it, every other date is as it is. */
export function heldDate(now) {
  const at = typeof now === "number" ? now : Date.parse(now);
  return class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [at]));
    }
    static now() {
      return at;
    }
  };
}

/** Timers that run only when told to: `second()` runs the one due next. */
export function fakeTimers() {
  const due = new Map();
  let id = 0;
  return {
    setTimeout: (callback) => {
      due.set(++id, callback);
      return id;
    },
    clearTimeout: (which) => due.delete(which),
    second() {
      const [[which, callback]] = due;
      due.delete(which);
      callback();
    },
    get waiting() {
      return due.size;
    },
  };
}
