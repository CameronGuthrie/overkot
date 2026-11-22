using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;

internal static partial class PlayerPositionReader
{
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);

    // Each fixture sets the ACL on itself and exits when its parent's input pipe closes.
    public static int RestrictedChild(bool allowRead)
    {
        string user = WindowsIdentity.GetCurrent().User.Value;
        string mask = allowRead ? "0x1410" : "0x1400";  // query, limited query, optionally VM_READ
        var acl = new RawSecurityDescriptor("D:(A;;" + mask + ";;;" + user + ")");
        var descriptor = new byte[acl.BinaryLength];
        acl.GetBinaryForm(descriptor, 0);
        if (!SetKernelObjectSecurity(GetCurrentProcess(), 4, descriptor))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        Console.WriteLine("ready");
        Console.Out.Flush();
        Console.ReadLine();
        return 259;
    }

    public static void CheckAccess(bool allowRead)
    {
        var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
            allowRead ? "allow-read" : "deny-read") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
        };
        using (Process child = Process.Start(start))
        {
            try
            {
                if (child.StandardOutput.ReadLine() != "ready") throw new Exception("Fixture did not set its ACL.");
                IntPtr sync = OpenProcess(0x100000, false, child.Id);
                int error = Marshal.GetLastWin32Error();
                if (sync != IntPtr.Zero) CloseHandle(sync);
                if (sync != IntPtr.Zero || error != 5) throw new Exception("Expected SYNCHRONIZE to be denied.");

                // The object returned by Start already owns a full-access handle.
                // Discover a fresh Process by PID, as the real reader does.
                using (Process view = Process.GetProcessById(child.Id))
                {
                    if (!allowRead)
                    {
                        try { using (new Reader(view)) { } }
                        catch (Win32Exception ex) { if (ex.NativeErrorCode == 5) return; throw; }
                        throw new Exception("The reader opened a child that denied VM_READ.");
                    }
                    using (var reader = new Reader(view))
                    {
                        byte[] header = new byte[2];
                        if (reader.HasExited() || !reader.Read(reader.ModuleBase, header, header.Length) ||
                            header[0] != 'M' || header[1] != 'Z') throw new Exception("Query/read-only tracking failed.");
                        child.StandardInput.Close();
                        if (!child.WaitForExit(5000) || child.ExitCode != 259) throw new Exception("Unexpected child exit.");
                        if (!SpinWait.SpinUntil(reader.HasExited, 3000)) throw new Exception("Reader missed an exit with code 259.");
                    }
                }
            }
            finally { child.StandardInput.Close(); if (!child.WaitForExit(5000)) child.Kill(); }
        }
    }
}

internal static class AccessChecks
{
    static int Main(string[] args)
    {
        if (args.Length > 0) return PlayerPositionReader.RestrictedChild(args[0] == "allow-read");
        // Framework process initialization can enable the debug privilege on elevated CI.
        // LeaveDebugMode initializes that subsystem and then disables it in this test runner.
        try { Process.LeaveDebugMode(); }
        catch (Win32Exception ex) { if (ex.NativeErrorCode != 1300) throw; } // Ordinary accounts lack the privilege.
        PlayerPositionReader.CheckAccess(true);
        PlayerPositionReader.CheckAccess(false);
        return 0;
    }
}
