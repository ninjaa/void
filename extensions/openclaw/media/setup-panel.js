(function () {
  // Acquire VS Code API — allows postMessage to/from the extension host
  var vscode = acquireVsCodeApi();

  var data = { channels: [] };
  var rawConfig = "";

  /* ── tiny toast ──────────────────────────────────────────────────────── */
  var toastEl = null;
  var toastTimer = null;
  function showToast(msg, type) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = [
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%)",
        "padding:10px 20px;border-radius:10px;font-size:13px;font-weight:500",
        "z-index:9999;pointer-events:none;transition:opacity .25s",
        "box-shadow:0 4px 20px rgba(0,0,0,.5)"
      ].join(";");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.background = type === "err" ? "#ef4444" : type === "warn" ? "#f59e0b" : "#22c55e";
    toastEl.style.color      = type === "warn" ? "#0f172a" : "#fff";
    toastEl.style.opacity    = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = "0"; }, 2800);
  }

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  function switchTab(tabName) {
    if (!tabName) return;
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "tab-" + tabName);
    });
  }

  function addToRecent(normalized) {
    var recentRow    = $("recent-commands");
    var commandInput = $("command-input");
    if (!recentRow) return;
    var pill = document.createElement("span");
    pill.className   = "pill clickable";
    pill.textContent = normalized;
    pill.addEventListener("click", function () {
      if (commandInput) commandInput.value = normalized;
    });
    recentRow.appendChild(pill);
  }

  function runCommand(cmd) {
    var normalized = (cmd || "").trim();
    if (!normalized) return;
    var fullCmd = normalized.startsWith("openclaw") ? normalized : "openclaw " + normalized;
    addToRecent(normalized);
    showToast("\u25b6 " + fullCmd, "ok");
    vscode.postMessage({ command: "openclaw.runCommand", text: normalized });
  }

  function sanitizeJson5(input) {
    return String(input || "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,\s*(\}|\])/g, "$1");
  }

  function validateConfig() {
    var configEditor = $("config-editor");
    var configStatus = $("config-status");
    var configHint   = $("config-hint");
    if (!configEditor || !configStatus || !configHint) return;
    try {
      JSON.parse(sanitizeJson5(configEditor.value));
      configStatus.textContent = "Valid JSON";
      configStatus.className   = "status-badge ok";
      configHint.textContent   = "Ready to save";
    } catch (err) {
      configStatus.textContent = "Invalid JSON";
      configStatus.className   = "status-badge err";
      configHint.textContent   = (err && err.message) || "Parse error";
    }
  }

  /* ── main UI wiring (called after init data arrives) ─────────────────── */
  function initUI() {
    /* delegated click handler — tabs, channel cards, quick command buttons */
    document.addEventListener("click", function (e) {
      var tabBtn = e.target && e.target.closest && e.target.closest(".tab");
      if (tabBtn) { switchTab(tabBtn.getAttribute("data-tab")); return; }

      var actionBtn = e.target && e.target.closest &&
                      e.target.closest(".channel-card [data-action]");
      if (actionBtn) {
        e.stopPropagation();
        var index       = Number(actionBtn.dataset.index);
        var action      = actionBtn.dataset.action;
        var channel     = (data.channels && data.channels[index]) || null;
        var channelName = (channel && channel.channel) || "channel";

        if (action === "pair") {
          showToast("Pairing started for " + channelName + " \u2026", "warn");
          vscode.postMessage({ command: "openclaw.channelPair", channel: channelName });
          return;
        }
        if (action === "configure") {
          switchTab("config");
          showToast("Editing config for " + channelName, "ok");
          vscode.postMessage({ command: "openclaw.channelConfigure", channel: channelName });
          return;
        }
      }

      var quickBtn = e.target && e.target.closest && e.target.closest(".quick-btn");
      if (quickBtn) {
        var cmd          = quickBtn.dataset.cmd || "";
        var commandInput = $("command-input");
        if (commandInput) commandInput.value = cmd;
        runCommand(cmd);
        return;
      }
    });

    /* Add Channel buttons */
    var addChannel = $("add-channel");
    if (addChannel) {
      addChannel.addEventListener("click", function () {
        showToast("Run: openclaw channels add", "warn");
        vscode.postMessage({ command: "openclaw.channelAdd" });
      });
    }

    var sidebarAdd = $("sidebar-add");
    if (sidebarAdd) {
      sidebarAdd.addEventListener("click", function () {
        showToast("Run: openclaw channels add", "warn");
        vscode.postMessage({ command: "openclaw.channelAdd" });
      });
    }

    /* View Status hint */
    var restartHint = $("restart-hint");
    if (restartHint) {
      restartHint.addEventListener("click", function () {
        showToast("Open the Status panel from the OpenClaw sidebar", "warn");
        vscode.postMessage({ command: "openclaw.viewStatus" });
      });
    }

    /* JSON editor */
    var configEditor = $("config-editor");
    if (configEditor) {
      configEditor.value = rawConfig;
      configEditor.addEventListener("input", validateConfig);
      validateConfig();
    }

    /* Save config */
    var btnSave = $("save-config");
    if (btnSave) {
      btnSave.addEventListener("click", function () {
        var editor       = $("config-editor");
        var configStatus = $("config-status");
        var configHint   = $("config-hint");
        if (!editor) return;
        try {
          JSON.parse(sanitizeJson5(editor.value));
          if (configStatus) { configStatus.textContent = "Saved"; configStatus.className = "status-badge ok"; }
          if (configHint)   { configHint.textContent   = "Configuration updated"; }
          showToast("Configuration saved", "ok");
          vscode.postMessage({ command: "openclaw.saveConfig", text: editor.value });
        } catch (err) {
          showToast("Fix JSON errors before saving", "err");
        }
      });
    }

    /* Command console */
    var runBtn       = $("run-command");
    var commandInput = $("command-input");

    if (runBtn) {
      runBtn.addEventListener("click", function () {
        runCommand(commandInput && commandInput.value);
      });
    }

    if (commandInput) {
      commandInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); runCommand(commandInput.value); }
      });
    }
  }

  /* ── Message bus: receive data from extension ───────────────────────── */
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg) return;

    if (msg.command === "init") {
      data      = msg.data   || { channels: [] };
      rawConfig = msg.config || "";
      initUI();
      return;
    }

    if (msg.command === "refresh") {
      data      = msg.data   || { channels: [] };
      rawConfig = msg.config || "";
      // Update config editor content if it exists
      var editor = $("config-editor");
      if (editor) editor.value = rawConfig;
      // Re-render channel cards if needed, or let next tab switch update
      showToast("Configuration updated externally", "ok");
      return;
    }
    if (msg.command === "openclaw.saveResult") {
      var configStatus = $("config-status");
      var configHint   = $("config-hint");
      if (msg.ok) {
        if (configStatus) { configStatus.textContent = "Saved"; configStatus.className = "status-badge ok"; }
        if (configHint)   { configHint.textContent   = "Configuration updated"; }
        showToast("Configuration saved", "ok");
      } else {
        showToast("Save failed", "err");
      }
      return;
    }
  });

  /* Signal readiness to the extension — triggers the init data response */
  vscode.postMessage({ command: "ready" });

}());
