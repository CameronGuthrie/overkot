using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

// A low-level mouse hook is needed for global wheel/side-button shortcuts.
// Forward every event except a recorded stroke or an exact configured binding.
public static class OverkotMouseShortcuts
{
    delegate IntPtr MouseProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseEvent { public Point Point; public uint MouseData; }
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, MouseProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint process);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

    sealed class Bindings
    {
        public string Interact, Visibility;
        public bool Capture;
        public uint Game;
        public IntPtr Settings;
        public bool Matches(string stroke) { return stroke == Interact || stroke == Visibility; }
    }
    sealed class Held { public string Stroke; public Bindings AtPress; }
    sealed class FocusRequest { public long Id, Time; public IntPtr Foreground; }
    static FocusRequest pendingFocus;
    static long sequence;
    static volatile Bindings current = new Bindings();
    static readonly Dictionary<string, Held> held = new Dictionary<string, Held>();
    static readonly MouseProc callback = OnMouse;
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static IntPtr hook;
    static uint owner;
    static string lastWheel;
    static long lastWheelAt;

    static uint ProcessOf(IntPtr window)
    {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        return pid;
    }

    static string Stroke(string button)
    {
        return (GetAsyncKeyState(0x11) < 0 ? "Ctrl+" : "") + (GetAsyncKeyState(0x12) < 0 ? "Alt+" : "")
             + (GetAsyncKeyState(0x10) < 0 ? "Shift+" : "")
             + (GetAsyncKeyState(0x5b) < 0 || GetAsyncKeyState(0x5c) < 0 ? "Super+" : "") + button;
    }

    static void Report(bool capture, string stroke)
    {
        if (!capture && current.Interact == stroke)
        {
            // Electron receives this user gesture via a pipe, so Windows may
            // still consider the game the last application to receive input.
            var request = new FocusRequest { Id = ++sequence, Time = clock.ElapsedMilliseconds, Foreground = GetForegroundWindow() };
            Interlocked.Exchange(ref pendingFocus, request);
            AllowSetForegroundWindow(owner);
            Console.WriteLine("press:" + stroke + ":" + request.Id);
        }
        else Console.WriteLine((capture ? "capture:" : "press:") + stroke);
    }

    static void FocusOverlay(string[] fields)
    {
        long id, raw;
        var request = Interlocked.Exchange(ref pendingFocus, null);
        if (request == null || fields.Length != 3 || !long.TryParse(fields[1], out id) || request.Id != id
            || !long.TryParse(fields[2], out raw) || clock.ElapsedMilliseconds - request.Time > 750) return;
        IntPtr target = new IntPtr(raw), foreground = GetForegroundWindow();
        if (ProcessOf(target) != owner || target == foreground || foreground != request.Foreground) return;
        if (SetForegroundWindow(target)) return;
        // The foreground game may own keyboard activation even after the
        // deliberate mouse gesture. Focus the now-interactive Overkot window.
        try
        {
            AutomationElement element = AutomationElement.FromHandle(target);
            if (element != null && !element.Current.IsKeyboardFocusable)
            {
                // Chromium's top-level HWND may be a non-focusable pane. Its
                // document or an accessible descendant can accept keyboard focus.
                var focusable = new PropertyCondition(AutomationElement.IsKeyboardFocusableProperty, true);
                var document = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
                element = element.FindFirst(TreeScope.Descendants, new AndCondition(focusable, document))
                       ?? element.FindFirst(TreeScope.Descendants, focusable);
            }

            if (element != null && GetForegroundWindow() == foreground && ProcessOf(target) == owner
                && clock.ElapsedMilliseconds - request.Time <= 750) element.SetFocus();
        }
        catch (ElementNotAvailableException) { } // Target closed during activation.
        catch (ElementNotEnabledException) { }
        catch (InvalidOperationException) { }   // Already hidden or no longer focusable.
        catch (TimeoutException) { }
        catch (COMException) { }                // Accessibility provider unavailable.
    }

    static bool Handle(int message, IntPtr data)
    {
        // WM_MOUSEMOVE is by far the most frequent event.
        if (message < 0x201 || message > 0x20e) return false;
        MouseEvent e = (MouseEvent)Marshal.PtrToStructure(data, typeof(MouseEvent));
        int value = (short)(e.MouseData >> 16);
        bool wheel = false, up = false;
        string button;
        switch (message)
        {
            case 0x201: case 0x202: button = "Mouse1"; up = message == 0x202; break;
            case 0x204: case 0x205: button = "Mouse2"; up = message == 0x205; break;
            case 0x207: case 0x208: button = "Mouse3"; up = message == 0x208; break;
            case 0x20b: case 0x20c:
                if (value != 1 && value != 2) return false;
                button = value == 1 ? "Mouse4" : "Mouse5"; up = message == 0x20c; break;
            case 0x20a: case 0x20e:
                if (value == 0) return false;
                button = message == 0x20a ? (value > 0 ? "WheelUp" : "WheelDown")
                                           : (value > 0 ? "WheelRight" : "WheelLeft");
                wheel = true; break;
            default: return false;
        }

        Bindings state = current;
        Held press;
        if (up)
        {
            if (!held.TryGetValue(button, out press)) return false;
            held.Remove(button);
            if (press.AtPress == state) Report(state.Capture, press.Stroke);
            return true;
        }
        if (held.ContainsKey(button)) return true;
        string stroke = Stroke(button);
        if (!state.Capture && !state.Matches(stroke)) return false;
        IntPtr foreground = GetForegroundWindow();
        if (state.Capture)
        {
            IntPtr target = GetAncestor(WindowFromPoint(e.Point), 2); // GA_ROOT
            if (ProcessOf(target) != owner || ProcessOf(foreground) != owner
                || (state.Settings != IntPtr.Zero && target != state.Settings)) return false;
        }
        else
        {
            if (foreground == state.Settings && foreground != IntPtr.Zero) return false;
            // Binding a plain primary click must leave the desktop and the
            // interactive overlay usable, including the first click away from the game.
            if ((stroke == "Mouse1" || stroke == "Mouse2") &&
                (state.Game == 0 || ProcessOf(foreground) != state.Game || ProcessOf(WindowFromPoint(e.Point)) != state.Game)) return false;
        }
        if (wheel)
        {
            long now = clock.ElapsedMilliseconds;
            bool newGesture = lastWheel != stroke || now - lastWheelAt >= 240;
            lastWheel = stroke; lastWheelAt = now;
            if (newGesture) Report(state.Capture, stroke);
        }
        else held[button] = new Held { Stroke = stroke, AtPress = state };
        return true;
    }

    static IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && Handle(message.ToInt32(), data)) return new IntPtr(1);
        return CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static void ReadState()
    {
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] fields = line.Split('|');
            if (fields[0] == "focus") { FocusOverlay(fields); continue; }
            uint game; long window;
            if (fields.Length == 5 && uint.TryParse(fields[3], out game) && long.TryParse(fields[4], out window))
                current = new Bindings { Interact = fields[0], Visibility = fields[1], Capture = fields[2] == "1",
                                         Game = game, Settings = new IntPtr(window) };
        }
        // Covers both ordinary shutdown and an unexpectedly closed app.
        Environment.Exit(0);
    }

    public static int Main(string[] args)
    {
        if (args.Length != 1 || !uint.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out owner)) return 2;
        hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0); // WH_MOUSE_LL
        if (hook == IntPtr.Zero) return 1;
        new Thread(ReadState) { IsBackground = true }.Start();
        try { Console.WriteLine("ready"); Application.Run(); }
        finally { UnhookWindowsHookEx(hook); }
        return 0;
    }
}
