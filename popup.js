// Popup: collect the user's criteria + credentials, persist them, and kick off
// a filter run in the active Zillow tab.

const els = {
  prompt: document.getElementById("prompt"),
  keyType: document.getElementById("keyType"),
  anthropicFields: document.getElementById("anthropicFields"),
  bedrockFields: document.getElementById("bedrockFields"),
  anthropicKey: document.getElementById("anthropicKey"),
  awsAccessKey: document.getElementById("awsAccessKey"),
  awsSecretKey: document.getElementById("awsSecretKey"),
  awsSessionToken: document.getElementById("awsSessionToken"),
  awsRegion: document.getElementById("awsRegion"),
  rememberKey: document.getElementById("rememberKey"),
  testBtn: document.getElementById("testBtn"),
  runBtn: document.getElementById("runBtn"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status"),
};

const STORAGE_KEY = "zcf_config";

function toggleProviderFields() {
  const isBedrock = els.keyType.value === "bedrock";
  els.bedrockFields.hidden = !isBedrock;
  els.anthropicFields.hidden = isBedrock;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

function readConfig() {
  return {
    prompt: els.prompt.value.trim(),
    keyType: els.keyType.value,
    anthropicKey: els.anthropicKey.value.trim(),
    aws: {
      accessKeyId: els.awsAccessKey.value.trim(),
      secretAccessKey: els.awsSecretKey.value.trim(),
      sessionToken: els.awsSessionToken.value.trim(),
      region: els.awsRegion.value.trim() || "us-east-1",
    },
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  els.prompt.value = cfg.prompt || "";
  els.keyType.value = cfg.keyType || "anthropic";
  els.anthropicKey.value = cfg.anthropicKey || "";
  if (cfg.aws) {
    els.awsAccessKey.value = cfg.aws.accessKeyId || "";
    els.awsSecretKey.value = cfg.aws.secretAccessKey || "";
    els.awsSessionToken.value = cfg.aws.sessionToken || "";
    els.awsRegion.value = cfg.aws.region || "us-east-1";
  }
  toggleProviderFields();
}

function validateCredentials(cfg) {
  if (cfg.keyType === "anthropic" && !cfg.anthropicKey)
    return "Enter your Anthropic API key.";
  if (cfg.keyType === "bedrock" && (!cfg.aws.accessKeyId || !cfg.aws.secretAccessKey))
    return "Enter your AWS access key and secret.";
  return null;
}

function validate(cfg) {
  if (!cfg.prompt) return "Enter your custom criteria.";
  return validateCredentials(cfg);
}

async function getActiveZillowTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/[^/]*\.zillow\.com\//.test(tab.url || "")) {
    return null;
  }
  return tab;
}

// Ensure the content script is actually running in the tab. After an extension
// reload, Chrome does NOT re-inject content scripts into already-open tabs, so
// messaging fails with "Receiving end does not exist". We ping; if there's no
// listener, we inject content.js + content.css and ping again.
async function ensureContentScript(tabId) {
  const ping = () =>
    chrome.tabs.sendMessage(tabId, { type: "PING" }).catch(() => null);

  if (await ping()) return true;

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    throw new Error("Couldn't inject into the page: " + e.message);
  }

  // Give the freshly injected script a moment to register its listener.
  for (let i = 0; i < 5; i++) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

els.keyType.addEventListener("change", toggleProviderFields);

els.testBtn.addEventListener("click", async () => {
  const cfg = readConfig();
  const err = validateCredentials(cfg);
  if (err) return setStatus(err, true);

  els.testBtn.disabled = true;
  setStatus(
    `Testing ${cfg.keyType === "bedrock" ? "Bedrock" : "Anthropic"} access to Opus 4.8…`
  );

  try {
    // Goes straight to the background worker — no Zillow tab required.
    const resp = await chrome.runtime.sendMessage({
      type: "TEST_CONNECTION",
      config: cfg,
    });
    if (resp && resp.ok) {
      setStatus(
        `✅ Connected. Model: ${resp.model}\nReply: ${resp.text || "(empty)"}`
      );
    } else {
      setStatus("❌ " + (resp?.error || "No response."), true);
    }
  } catch (e) {
    setStatus("❌ " + e.message, true);
  } finally {
    els.testBtn.disabled = false;
  }
});

els.runBtn.addEventListener("click", async () => {
  const cfg = readConfig();
  const err = validate(cfg);
  if (err) return setStatus(err, true);

  // Persist (credentials only if "remember" is checked).
  const toStore = els.rememberKey.checked
    ? cfg
    : { prompt: cfg.prompt, keyType: cfg.keyType };
  await chrome.storage.local.set({ [STORAGE_KEY]: toStore });

  const tab = await getActiveZillowTab();
  if (!tab) return setStatus("Open a Zillow search page first.", true);

  els.runBtn.disabled = true;
  setStatus("Reading filters and listings…");

  try {
    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      setStatus("Couldn't start on this page. Reload the Zillow tab.", true);
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_FILTER",
      config: cfg,
    });
    if (resp && resp.ok) {
      let msg = `Done. ${resp.kept} kept, ${resp.hidden} hidden (of ${resp.total}).`;
      if (resp.errored) {
        msg +=
          `\n\n⚠️ ${resp.errored} listing(s) failed evaluation. ` +
          `First error:\n${resp.firstError}`;
        setStatus(msg, true);
      } else {
        setStatus(msg);
      }
    } else {
      setStatus(resp?.error || "No response from page.", true);
    }
  } catch (e) {
    setStatus(
      "Couldn't reach the page. Reload the Zillow tab and try again.\n" +
        e.message,
      true
    );
  } finally {
    els.runBtn.disabled = false;
  }
});

els.resetBtn.addEventListener("click", async () => {
  const tab = await getActiveZillowTab();
  if (!tab) return setStatus("Open a Zillow search page first.", true);
  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "RESET_FILTER" });
    setStatus("Page restored.");
  } catch (e) {
    setStatus("Couldn't reach the page.", true);
  }
});

// Load saved config on open.
chrome.storage.local.get(STORAGE_KEY).then((res) => {
  applyConfig(res[STORAGE_KEY]);
});
