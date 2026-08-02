import {
  Interocitor,
  types,
  type DatabaseSchemaDefinition,
} from "../../../packages/core/src/index.ts";
import { IndexedDbLocalStore } from "../../../packages/web/src/index.ts";

type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
};

type DB = { todos: Todo };

const schema = {
  tables: {
    todos: {
      fields: {
        id: types.string,
        title: types.string,
        done: types.boolean,
        createdAt: types.index(types.number),
      },
    },
  },
} satisfies DatabaseSchemaDefinition<DB>;

type Filter = "all" | "active" | "completed";

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

const form = element<HTMLFormElement>("#new-todo-form");
const input = element<HTMLInputElement>("#new-todo");
const list = element<HTMLUListElement>("#todo-list");
const emptyState = element<HTMLParagraphElement>("#empty-state");
const count = element<HTMLSpanElement>("#item-count");
const status = element<HTMLSpanElement>("#storage-status");
const toggleAll = element<HTMLButtonElement>("#toggle-all");
const clearCompleted = element<HTMLButtonElement>("#clear-completed");
const filterButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-filter]")];

const dbName = "interocitor-public-todomvc-v1";
const db = new Interocitor<DB>({
  dbName,
  schema,
  localStore: new IndexedDbLocalStore(dbName),
  keySource: null,
});

const todos = db.table("todos");
let currentFilter: Filter = "all";
let latestRender = 0;

function describeCount(total: number, active: number): string {
  if (total === 0) return "0 tasks";
  return `${active} ${active === 1 ? "task" : "tasks"} left`;
}

function visibleTodos(all: Todo[]): Todo[] {
  if (currentFilter === "active") return all.filter((todo) => !todo.done);
  if (currentFilter === "completed") return all.filter((todo) => todo.done);
  return all;
}

function beginEdit(todo: Todo, label: HTMLSpanElement): void {
  const editor = document.createElement("input");
  editor.className = "edit-input";
  editor.type = "text";
  editor.value = todo.title;
  editor.maxLength = 240;
  editor.setAttribute("aria-label", `Edit ${todo.title}`);
  label.replaceWith(editor);
  editor.focus();
  editor.select();

  let settled = false;
  const finish = async (save: boolean) => {
    if (settled) return;
    settled = true;
    const title = editor.value.trim();
    if (save && title && title !== todo.title) {
      await todos.patch(todo.id, { title });
    } else {
      await render();
    }
  };

  editor.addEventListener("blur", () => void finish(true));
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") editor.blur();
    if (event.key === "Escape") void finish(false);
  });
}

function todoElement(todo: Todo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `todo-item${todo.done ? " completed" : ""}`;

  const toggle = document.createElement("input");
  toggle.className = "todo-toggle";
  toggle.type = "checkbox";
  toggle.checked = todo.done;
  toggle.setAttribute("aria-label", `Mark ${todo.title} ${todo.done ? "active" : "complete"}`);
  toggle.addEventListener("change", () => void todos.patch(todo.id, { done: toggle.checked }));

  const title = document.createElement("span");
  title.className = "todo-title";
  title.textContent = todo.title;
  title.title = "Double-click to edit";
  title.addEventListener("dblclick", () => beginEdit(todo, title));

  const destroy = document.createElement("button");
  destroy.className = "destroy";
  destroy.type = "button";
  destroy.textContent = "×";
  destroy.setAttribute("aria-label", `Delete ${todo.title}`);
  destroy.addEventListener("click", () => void todos.delete(todo.id));

  item.append(toggle, title, destroy);
  return item;
}

async function render(): Promise<void> {
  const renderId = ++latestRender;
  const all = (await todos.query()).toSorted((a, b) => a.createdAt - b.createdAt);
  if (renderId !== latestRender) return;

  const visible = visibleTodos(all);
  const active = all.filter((todo) => !todo.done).length;
  list.replaceChildren(...visible.map(todoElement));
  count.textContent = describeCount(all.length, active);
  emptyState.hidden = visible.length > 0;
  emptyState.textContent =
    all.length === 0 ? "Your local list is ready." : `No ${currentFilter} tasks.`;
  clearCompleted.disabled = !all.some((todo) => todo.done);
  toggleAll.disabled = all.length === 0;
  toggleAll.textContent = active === 0 && all.length > 0 ? "Mark all active" : "Complete all";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;

  const id = `todo_${crypto.randomUUID()}`;
  input.value = "";
  await todos.put(id, { id, title, done: false, createdAt: Date.now() });
  input.focus();
});

toggleAll.addEventListener("click", async () => {
  const all = await todos.query();
  const nextDone = all.some((todo) => !todo.done);
  await db.batch(async () => {
    for (const todo of all) await todos.patch(todo.id, { done: nextDone });
  });
});

clearCompleted.addEventListener("click", async () => {
  const completed = (await todos.query()).filter((todo) => todo.done);
  await db.batch(async () => {
    for (const todo of completed) await todos.delete(todo.id);
  });
});

for (const button of filterButtons) {
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter as Filter;
    for (const peer of filterButtons) {
      peer.setAttribute("aria-pressed", String(peer === button));
    }
    void render();
  });
}

try {
  await db.init();
  todos.subscribe(() => void render());
  await render();
  status.textContent = "Saved in this browser";
  document.documentElement.dataset.ready = "true";
  input.focus();
} catch (error) {
  status.classList.add("error");
  status.textContent = "Local storage unavailable";
  form.querySelectorAll("input, button").forEach((control) => {
    (control as HTMLInputElement | HTMLButtonElement).disabled = true;
  });
  console.error(error);
}

window.addEventListener("beforeunload", () => {
  void db.disconnect();
});
