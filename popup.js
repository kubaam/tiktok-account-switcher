const listEl = document.getElementById("list");
const nameEl = document.getElementById("name");
const statusEl = document.getElementById("status");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "";
}

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? "Bez odpovědi z background skriptu.");
  return res.data;
}

async function run(label, fn) {
  setStatus(label);
  try {
    const done = await fn();
    setStatus(typeof done === "string" ? done : "Hotovo.");
    await render();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

async function render() {
  const { accounts, active } = await call("list");
  listEl.replaceChildren();
  if (accounts.length === 0) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "Žádné uložené účty. Přihlas se na TikTok a ulož ho.";
    listEl.append(p);
    return;
  }
  for (const acc of accounts) {
    const li = document.createElement("li");
    if (acc.name === active) li.classList.add("active");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = acc.name;
    name.title = `Uloženo ${new Date(acc.savedAt).toLocaleString()}`;
    name.addEventListener("click", () => run(`Přepínám na ${acc.name}…`, () => call("switchTo", { name: acc.name })));

    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Smazat";
    del.addEventListener("click", () => {
      if (confirm(`Smazat účet ${acc.name}?`)) run("Mažu…", () => call("remove", { name: acc.name }));
    });

    li.append(name, del);
    listEl.append(li);
  }
}

document.getElementById("save").addEventListener("click", () =>
  run("Ukládám…", async () => {
    const { name } = await call("saveCurrent", { name: nameEl.value });
    nameEl.value = "";
    return `Uloženo jako ${name}.`;
  })
);

document.getElementById("add").addEventListener("click", () =>
  run("Odhlašuji a otevírám login…", () => call("addNew"))
);

render().catch((err) => setStatus(err.message, true));
