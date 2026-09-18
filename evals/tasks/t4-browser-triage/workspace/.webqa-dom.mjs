// The DOM half of `webqa`: an HTML parser, an element tree, a selector
// engine and event dispatch. Small on purpose — it implements the subset the
// app under test uses and nothing else, so the behaviour a harness observes
// is fully determined by files in this workspace.

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "wbr"]);

const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;

export const runtimeHooks = { onUncaught: null };

function parseAttributes(source) {
    const attributes = new Map();
    ATTRIBUTE_PATTERN.lastIndex = 0;
    let match = ATTRIBUTE_PATTERN.exec(source);
    while (match !== null) {
        attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
        match = ATTRIBUTE_PATTERN.exec(source);
    }

    return attributes;
}

function escapeHtml(text) {
    return String(text).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

function appendText(parent, text) {
    if (text.length === 0) {
        return;
    }

    const node = new Element("#text");
    node.data = text;
    parent.appendChild(node);
}

export function parseHtml(source) {
    const root = new Element("#document");
    const stack = [root];
    let index = 0;
    while (index < source.length) {
        const next = source.indexOf("<", index);
        if (next < 0) {
            appendText(stack[stack.length - 1], source.slice(index));
            break;
        }

        if (next > index) {
            appendText(stack[stack.length - 1], source.slice(index, next));
        }

        if (source.startsWith("<!--", next)) {
            const close = source.indexOf("-->", next);
            index = close < 0 ? source.length : close + 3;
            continue;
        }

        if (source.startsWith("<!", next)) {
            const close = source.indexOf(">", next);
            index = close < 0 ? source.length : close + 1;
            continue;
        }

        const close = source.indexOf(">", next);
        if (close < 0) {
            appendText(stack[stack.length - 1], source.slice(next));
            break;
        }

        const raw = source.slice(next + 1, close).trim();
        index = close + 1;
        if (raw.startsWith("/")) {
            const name = raw.slice(1).trim().toLowerCase();
            for (let depth = stack.length - 1; depth > 0; depth--) {
                if (stack[depth].tagName === name) {
                    stack.length = depth;
                    break;
                }
            }

            continue;
        }

        const selfClosing = raw.endsWith("/");
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const space = body.search(/\s/u);
        const name = (space < 0 ? body : body.slice(0, space)).toLowerCase();
        const element = new Element(name);
        if (space >= 0) {
            element.attributes = parseAttributes(body.slice(space));
        }

        stack[stack.length - 1].appendChild(element);
        if (name === "script" || name === "style") {
            const lowered = source.toLowerCase();
            const closing = lowered.indexOf(`</${name}`, index);
            appendText(element, source.slice(index, closing < 0 ? source.length : closing));
            index = closing < 0 ? source.length : source.indexOf(">", closing) + 1;
            continue;
        }

        if (!selfClosing && !VOID_TAGS.has(name)) {
            stack.push(element);
        }
    }

    return root;
}

export class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.attributes = new Map();
        this.childNodes = [];
        this.parentNode = null;
        this.listeners = new Map();
        this.data = "";
        this.style = {};
        this.ownerDocument = null;
        this.valueOverride = null;
        this.checkedOverride = null;
    }

    get nodeType() {
        return this.tagName === "#text" ? 3 : 1;
    }

    get children() {
        return this.childNodes.filter((node) => node.nodeType === 1);
    }

    get firstElementChild() {
        return this.children[0] ?? null;
    }

    get id() {
        return this.attributes.get("id") ?? "";
    }

    set id(value) {
        this.attributes.set("id", String(value));
    }

    get className() {
        return this.attributes.get("class") ?? "";
    }

    set className(value) {
        this.attributes.set("class", String(value));
    }

    get classList() {
        const owner = this;
        const read = () => (owner.className.length === 0 ? [] : owner.className.split(/\s+/u).filter(Boolean));
        const write = (list) => {
            owner.className = [...new Set(list)].join(" ");
        };

        return {
            add: (...names) => write([...read(), ...names]),
            remove: (...names) => write(read().filter((name) => !names.includes(name))),
            contains: (name) => read().includes(name),
            toggle: (name, force) => {
                const has = read().includes(name);
                const next = force === undefined ? !has : Boolean(force);
                write(next ? [...read(), name] : read().filter((entry) => entry !== name));

                return next;
            },
        };
    }

    get value() {
        if (this.valueOverride !== null) {
            return this.valueOverride;
        }

        if (this.tagName === "textarea") {
            return this.textContent;
        }

        return this.attributes.get("value") ?? "";
    }

    set value(next) {
        this.valueOverride = String(next);
    }

    get checked() {
        return this.checkedOverride === null ? this.attributes.has("checked") : this.checkedOverride;
    }

    set checked(next) {
        this.checkedOverride = Boolean(next);
    }

    get disabled() {
        return this.attributes.has("disabled");
    }

    set disabled(next) {
        if (next) {
            this.attributes.set("disabled", "");
        } else {
            this.attributes.delete("disabled");
        }
    }

    get hidden() {
        return this.attributes.has("hidden");
    }

    set hidden(next) {
        if (next) {
            this.attributes.set("hidden", "");
        } else {
            this.attributes.delete("hidden");
        }
    }

    get textContent() {
        if (this.nodeType === 3) {
            return this.data;
        }

        return this.childNodes.map((node) => node.textContent).join("");
    }

    set textContent(next) {
        this.childNodes = [];
        appendText(this, String(next));
    }

    get innerHTML() {
        return this.childNodes.map((node) => node.outerHTML).join("");
    }

    set innerHTML(next) {
        const parsed = parseHtml(String(next));
        this.childNodes = [];
        for (const child of [...parsed.childNodes]) {
            this.appendChild(child);
        }
    }

    get outerHTML() {
        if (this.nodeType === 3) {
            return escapeHtml(this.data);
        }

        const attributes = [...this.attributes]
            .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
            .join("");
        if (VOID_TAGS.has(this.tagName)) {
            return `<${this.tagName}${attributes}>`;
        }

        return `<${this.tagName}${attributes}>${this.innerHTML}</${this.tagName}>`;
    }

    getAttribute(name) {
        const value = this.attributes.get(String(name).toLowerCase());

        return value === undefined ? null : value;
    }

    setAttribute(name, value) {
        this.attributes.set(String(name).toLowerCase(), String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(String(name).toLowerCase());
    }

    hasAttribute(name) {
        return this.attributes.has(String(name).toLowerCase());
    }

    appendChild(child) {
        child.parentNode = this;
        child.ownerDocument = this.ownerDocument;
        this.childNodes.push(child);

        return child;
    }

    removeChild(child) {
        this.childNodes = this.childNodes.filter((node) => node !== child);

        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    matches(selector) {
        return matchesSelector(this, selector);
    }

    closest(selector) {
        let current = this;
        while (current && current.nodeType === 1) {
            if (matchesSelector(current, selector)) {
                return current;
            }

            current = current.parentNode;
        }

        return null;
    }

    querySelector(selector) {
        return query(this, selector)[0] ?? null;
    }

    querySelectorAll(selector) {
        return query(this, selector);
    }

    addEventListener(type, handler) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    removeEventListener(type, handler) {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((entry) => entry !== handler),
        );
    }

    dispatchEvent(event) {
        return dispatch(this, event);
    }

    focus() {
        if (this.ownerDocument) {
            this.ownerDocument.activeElement = this;
        }
    }

    click() {
        return dispatch(this, makeEvent("click"));
    }
}

const COMPOUND_PATTERN = /([#.]?[-\w]+)|(\[[^\]]+\])/gu;

function parseCompound(text) {
    const compound = { tag: null, id: null, classes: [], attributes: [] };
    COMPOUND_PATTERN.lastIndex = 0;
    let match = COMPOUND_PATTERN.exec(text);
    while (match !== null) {
        const token = match[0];
        if (token.startsWith("#")) {
            compound.id = token.slice(1);
        } else if (token.startsWith(".")) {
            compound.classes.push(token.slice(1));
        } else if (token.startsWith("[")) {
            const body = token.slice(1, -1);
            const equals = body.indexOf("=");
            if (equals < 0) {
                compound.attributes.push([body.trim(), null]);
            } else {
                const name = body.slice(0, equals).trim();
                const value = body
                    .slice(equals + 1)
                    .trim()
                    .replace(/^["']|["']$/gu, "");
                compound.attributes.push([name, value]);
            }
        } else {
            compound.tag = token.toLowerCase();
        }

        match = COMPOUND_PATTERN.exec(text);
    }

    return compound;
}

function matchesCompound(element, compound) {
    if (element.nodeType !== 1) {
        return false;
    }

    if (compound.tag !== null && compound.tag !== "*" && element.tagName !== compound.tag) {
        return false;
    }

    if (compound.id !== null && element.id !== compound.id) {
        return false;
    }

    for (const name of compound.classes) {
        if (!element.classList.contains(name)) {
            return false;
        }
    }

    for (const [name, value] of compound.attributes) {
        if (!element.hasAttribute(name)) {
            return false;
        }

        if (value !== null && element.getAttribute(name) !== value) {
            return false;
        }
    }

    return true;
}

function parseSelector(selector) {
    return String(selector)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const sequence = [];
            let child = false;
            for (const token of part.split(/\s+/u)) {
                if (token === ">") {
                    child = true;
                } else {
                    sequence.push({ compound: parseCompound(token), child });
                    child = false;
                }
            }

            return sequence;
        });
}

function matchesSequence(element, sequence) {
    let index = sequence.length - 1;
    if (!matchesCompound(element, sequence[index].compound)) {
        return false;
    }

    let current = element.parentNode;
    let direct = sequence[index].child;
    index -= 1;
    while (index >= 0) {
        let found = false;
        while (current && current.nodeType === 1) {
            const parent = current.parentNode;
            if (matchesCompound(current, sequence[index].compound)) {
                found = true;
                current = parent;
                break;
            }

            if (direct) {
                return false;
            }

            current = parent;
        }

        if (!found) {
            return false;
        }

        direct = sequence[index].child;
        index -= 1;
    }

    return true;
}

export function matchesSelector(element, selector) {
    return parseSelector(selector).some((sequence) => sequence.length > 0 && matchesSequence(element, sequence));
}

export function query(root, selector) {
    const sequences = parseSelector(selector);
    const found = [];
    const visit = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 1) {
                if (sequences.some((sequence) => sequence.length > 0 && matchesSequence(child, sequence))) {
                    found.push(child);
                }

                visit(child);
            }
        }
    };

    visit(root);

    return found;
}

export function makeEvent(type, detail = {}) {
    return {
        type,
        detail,
        target: null,
        currentTarget: null,
        bubbles: true,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
        stopPropagation() {
            this.propagationStopped = true;
        },
    };
}

// A handler that throws must not take the browser down with it: real pages
// log an uncaught error and carry on, and a QA task where one broken widget
// blanks every other one would measure the fixture rather than the harness.
export function dispatch(target, event) {
    event.target = target;
    const ancestors = [];
    let current = target;
    while (current) {
        ancestors.push(current);
        current = current.parentNode;
    }

    for (const node of event.bubbles ? ancestors : [target]) {
        for (const handler of [...(node.listeners.get(event.type) ?? [])]) {
            event.currentTarget = node;
            try {
                handler.call(node, event);
            } catch (error) {
                runtimeHooks.onUncaught?.(error);
            }
        }

        if (event.propagationStopped) {
            break;
        }
    }

    return !event.defaultPrevented;
}
