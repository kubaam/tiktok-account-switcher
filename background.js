// Account switching runs in the service worker so closing the popup never interrupts a cookie swap.

const COOKIE_DOMAIN = "tiktok.com";
const STORAGE_KEY = "accounts";

async function getTikTokCookies() {
  return chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
}

function cookieUrl(cookie) {
  const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return `https://${host}${cookie.path}`;
}

async function clearTikTokCookies() {
  const cookies = await getTikTokCookies();
  await Promise.all(
    cookies.map((c) =>
      chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId })
    )
  );
}

async function restoreCookie(c) {
  const details = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    storeId: c.storeId,
  };
  // Host-only cookies must be set without a domain, otherwise Chrome turns them into domain cookies.
  if (!c.hostOnly) details.domain = c.domain;
  if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
  if (c.sameSite && c.sameSite !== "unspecified") details.sameSite = c.sameSite;
  const result = await chrome.cookies.set(details);
  if (!result) {
    throw new Error(`Cookie "${c.name}" (${c.domain}) se nepodařilo nastavit: ${chrome.runtime.lastError?.message ?? "neznámá chyba"}`);
  }
}

async function loadAccounts() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

async function reloadTikTokTabs(openIfNone) {
  const tabs = await chrome.tabs.query({ url: "https://*.tiktok.com/*" });
  if (tabs.length === 0) {
    if (openIfNone) await chrome.tabs.create({ url: openIfNone });
    return;
  }
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
}

function extractUniqueId(html) {
  const match = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    const uniqueId = data?.__DEFAULT_SCOPE__?.["webapp.app-context"]?.user?.uniqueId;
    return typeof uniqueId === "string" && uniqueId ? uniqueId : null;
  } catch {
    return null;
  }
}

// Reads the logged-in user's @handle from TikTok's hydration JSON; tries an open tab first, then a direct fetch.
async function detectNick() {
  const tabs = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
  for (const tab of tabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.outerHTML ?? "",
      });
      const nick = extractUniqueId(res?.result ?? "");
      if (nick) return nick;
    } catch (err) {
      console.warn(`Nick detection in tab ${tab.id} failed:`, err);
    }
  }
  const resp = await fetch("https://www.tiktok.com/", { credentials: "include" });
  if (!resp.ok) return null;
  return extractUniqueId(await resp.text());
}

async function saveCurrent(name) {
  const cookies = await getTikTokCookies();
  if (!cookies.some((c) => c.name === "sessionid" && c.value)) {
    throw new Error("Nejsi přihlášen na TikTok (chybí cookie sessionid).");
  }
  let trimmed = String(name ?? "").trim();
  if (!trimmed) {
    const nick = await detectNick();
    if (!nick) throw new Error("Nick se nepodařilo zjistit, zadej jméno ručně.");
    trimmed = `@${nick}`;
  }
  const accounts = await loadAccounts();
  const existing = accounts.find((a) => a.name === trimmed);
  const entry = { name: trimmed, cookies, savedAt: new Date().toISOString() };
  if (existing) Object.assign(existing, entry);
  else accounts.push(entry);
  await saveAccounts(accounts);
  await chrome.storage.local.set({ active: trimmed });
  return { name: trimmed };
}

async function switchTo(name) {
  const accounts = await loadAccounts();
  const account = accounts.find((a) => a.name === name);
  if (!account) throw new Error(`Účet "${name}" neexistuje.`);

  // Persist the active account's refreshed cookies before leaving it, so rotated tokens are not lost.
  const { active } = await chrome.storage.local.get("active");
  if (active && active !== name) {
    const current = accounts.find((a) => a.name === active);
    const cookies = await getTikTokCookies();
    if (current && cookies.some((c) => c.name === "sessionid" && c.value)) {
      current.cookies = cookies;
      await saveAccounts(accounts);
    }
  }

  await clearTikTokCookies();
  const nowSec = Date.now() / 1000;
  for (const c of account.cookies) {
    if (!c.session && c.expirationDate && c.expirationDate < nowSec) continue;
    await restoreCookie(c);
  }
  await chrome.storage.local.set({ active: name });
  await reloadTikTokTabs("https://www.tiktok.com/");
}

async function addNew() {
  await clearTikTokCookies();
  await chrome.storage.local.remove("active");
  await reloadTikTokTabs(null);
  await chrome.tabs.create({ url: "https://www.tiktok.com/login" });
}

async function removeAccount(name) {
  const accounts = await loadAccounts();
  await saveAccounts(accounts.filter((a) => a.name !== name));
  const { active } = await chrome.storage.local.get("active");
  if (active === name) await chrome.storage.local.remove("active");
}

const handlers = {
  list: async () => ({ accounts: (await loadAccounts()).map((a) => ({ name: a.name, savedAt: a.savedAt })), active: (await chrome.storage.local.get("active")).active ?? null }),
  saveCurrent: (msg) => saveCurrent(msg.name),
  switchTo: (msg) => switchTo(msg.name),
  addNew: () => addNew(),
  remove: (msg) => removeAccount(msg.name),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Neznámá akce: ${msg?.type}` });
    return false;
  }
  handler(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});
