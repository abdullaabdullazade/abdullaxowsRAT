# RATxows

**Educational Remote Administration Tool (RAT)**

**abdullaxowsRAT** serves as a conceptual framework demonstrating how modern Electron and Node.js applications integrate with native Windows APIs. It is designed **strictly as an academic Proof of Concept (PoC)** to assist incident responders, security researchers, and malware analysts in understanding endpoint observation techniques and Remote Administration Tool (RAT) architectures.

> **LEGAL DISCLAIMER AND ACCEPTABLE USE POLICY**  
> This software is provided "as-is" for **educational and defensive cybersecurity research purposes only**. It must only be used in controlled, isolated environments or on systems where you have explicit authorized consent from the owner.  
> 
> The author (**abdullaxows**) is **not responsible** for any misuse, damage, or illegal activity caused by this software. By downloading, cloning, or using this repository, you agree to comply with all applicable local, state, and federal laws. Using this tool to monitor systems or exfiltrate data without strictly authorized consent is illegal and strictly prohibited.

---

## Academic Focus: Understanding Endpoint Telemetry

In modern cybersecurity, it is essential to understand how legitimate administrative tools and applications can access system resources. This project serves as a transparency model for the following concepts:

### 1. Alternate Command & Control (C2) Channels
Demonstrates how applications can utilize third-party APIs (such as the Telegram Bot API) to transmit administrative telemetry, circumventing traditional inbound network requirements. 
* *Research objective:* Analyzing API polling mechanisms to improve network intrusion detection signatures.

### 2. Native Interface Interaction
Shows how standard Node.js applications can utilize Windows-specific modules (such as PowerShell or WinRT) to gather peripheral telemetry (audio, camera) and system states (registry keys, active processes).
* *Research objective:* Developing better Endpoint Detection and Response (EDR) rules for cross-runtime execution (e.g., JavaScript calling PowerShell). 

### 3. File System Auditing
Illustrates basic polling mechanisms (`fs.promises`) that monitor specified directories for file alterations or creation.
* *Research objective:* Simulating ransomware staging behavior or unauthorized data collection to test file integrity monitoring (FIM) systems.

---

## Operational Concepts Demonstrated

This PoC includes several conceptual modules that a security analyst might encounter in the wild. **These are implemented for educational demonstration only.**

* **Diagnostic Interfaces:** Retrieving system metadata, memory usage, CPU, local network IP configurations, and installed software indices via WMI/Registry queries.
* **Process Execution:** Using standard JavaScript `child_process` modules to spawn benign processes or open local reverse TCP sockets.
* **Peripheral Access:** Calling Windows Multimedia APIs (`winmm.dll`) and `MediaCapture` to test how operating systems prompt users for permission when hardware is engaged covertly.
* **Input Monitoring:** A conceptual logging process to demonstrate how asynchronous, detached processes interact with `GetAsyncKeyState` in Windows.
* **ASAR Packaging bypass:** Demonstrates how developers extract and run external `.ps1` scripts from within an Electron `.asar` package without alerting heuristic scanners.

---

## Local Setup & Study

The variables required for testing are meant to be kept strictly local in a `.env` file. Do not commit credentials to the repository.

```ini
# API Configuration for the control endpoint
BOT_TOKEN=YOUR_TEST_TOKEN
ADMIN_CHAT_ID=YOUR_TEST_CHAT_ID

# Testing parameters
C2_HOST=127.0.0.1
C2_PORT=4444
```

### Packaging for Sandbox Analysis
To build the application for local malware sandbox testing or reverse engineering practice:

```bash
npm run make
```

---

*This repository exists solely to promote defense-in-depth principles and improve the cybersecurity community's understanding of systemic vulnerabilities. Researched and structured by **abdullaxows**.*
