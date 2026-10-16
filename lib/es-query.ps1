# lib/es-query.ps1 - Everything IPC query helper (WM_COPYDATA, no ES.exe needed).
#
# Queries a running Everything (1.4.x) instance over its documented IPC and
# prints one full path per line to stdout (UTF-8). Exit codes:
#   0 = success (possibly zero results)
#   2 = Everything is not running (IPC window not found)
#   3 = query sent but no reply within -TimeoutMs
#   4 = SendMessage failed
#   5 = unexpected error
#
# Protocol notes (reverse-engineered & live-verified on Everything 1.4.1.1026,
# 2026-10-16, cross-checked against the official IPC C example):
#   - Target window class: "EVERYTHING_TASKBAR_NOTIFICATION".
#   - EVERYTHING_IPC_QUERYW is pack(1): reply_hwnd(4B) / reply_copydata_message /
#     search_flags / offset / max_results, then the UTF-16 search string.
#     (Field ORDER follows the official layout; hwnd is stored as 4 bytes.)
#   - WM_COPYDATA dwData = 2 (COPYDATAQUERYW).
#   - The reply is sent asynchronously to reply_hwnd: the caller window must
#     stay alive and pump messages after SendMessage returns.
#   - Reply layout (live-verified, differs from the 1.3-era docs):
#       +0x04 totitems, +0x08 numitems,
#       items start at +0x1C, 12 bytes each: (flags, fn_off, pa_off),
#       fn_off/pa_off are BYTE offsets relative to the reply buffer start.
param(
  [Parameter(Mandatory = $true)][string]$Query,
  [int]$Max = 100,
  [int]$TimeoutMs = 4000
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

public static class EsIpc
{
    public static string[] Results = new string[0];
    public static bool GotReply = false;

    private const uint WM_COPYDATA = 0x004A;
    private const string IPC_WNDCLASS = "EVERYTHING_TASKBAR_NOTIFICATION";
    [StructLayout(LayoutKind.Sequential)]
    private struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
    private delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowW(string cls, string win);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassW(ref WNDCLASS wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowExW(uint ex, string cls, string win, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SendMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool PeekMessageW(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref MSG msg);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS
    {
        public uint style; public WndProcDelegate lpfnWndProc;
        public int cbClsExtra; public int cbWndExtra;
        public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor;
        public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName;
    }

    private static IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_COPYDATA)
        {
            COPYDATASTRUCT cds = (COPYDATASTRUCT)Marshal.PtrToStructure(lParam, typeof(COPYDATASTRUCT));
            try
            {
                int num = Marshal.ReadInt32(cds.lpData, 8); // numitems at +0x08
                var list = new string[num];
                for (int i = 0; i < num; i++)
                {
                    // items at +0x1C, 12B each: (flags, fn_off, pa_off); offsets relative to buffer
                    IntPtr item = new IntPtr(cds.lpData.ToInt64() + 0x1C + 12L * i);
                    int fnOff = Marshal.ReadInt32(item, 4);
                    int paOff = Marshal.ReadInt32(item, 8);
                    string fn = Marshal.PtrToStringUni(new IntPtr(cds.lpData.ToInt64() + fnOff));
                    string pa = Marshal.PtrToStringUni(new IntPtr(cds.lpData.ToInt64() + paOff));
                    list[i] = (pa == null ? "" : pa) + "\\" + (fn == null ? "" : fn);
                }
                Results = list;
            }
            catch { Results = new string[0]; }
            GotReply = true;
            return (IntPtr)1;
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    // searchFlags bits (official): 0x01 matchcase, 0x02 wholeword, 0x04 matchpath, 0x08 regex.
    // Returns 0 sent, 1 window not found, 4 SendMessage failed.
    public static int Query(string search, uint maxResults, uint searchFlags, uint waitMs)
    {
        Results = new string[0]; GotReply = false;
        IntPtr everythingHwnd = FindWindowW(IPC_WNDCLASS, null);
        if (everythingHwnd == IntPtr.Zero) return 1;
        string cls = "DSH_ES_IPC_" + Guid.NewGuid().ToString("N");
        var proc = new WndProcDelegate(WndProc);
        var wc = new WNDCLASS();
        wc.lpfnWndProc = proc; wc.lpszClassName = cls;
        wc.hInstance = Marshal.GetHINSTANCE(typeof(EsIpc).Module);
        if (RegisterClassW(ref wc) == 0) return 4;
        IntPtr hwnd = CreateWindowExW(0, cls, null, 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return 4;
        int ret = 0;
        try
        {
            int strBytes = (search.Length + 1) * 2;
            int size = 20 + strBytes; // pack(1) header: hwnd4 + 3*dword + hwnd... see layout above
            IntPtr buf = Marshal.AllocHGlobal(size);
            Marshal.WriteInt32(buf, 0, unchecked((int)hwnd.ToInt32())); // reply_hwnd (4B)
            Marshal.WriteInt32(buf, 4, 0);                              // reply_copydata_message
            Marshal.WriteInt32(buf, 8, (int)searchFlags);               // search_flags
            Marshal.WriteInt32(buf, 12, 0);                             // offset
            Marshal.WriteInt32(buf, 16, (int)maxResults);               // max_results
            byte[] sb = Encoding.Unicode.GetBytes(search + "\0");
            Marshal.Copy(sb, 0, new IntPtr(buf.ToInt64() + 20), sb.Length);
            COPYDATASTRUCT cds = new COPYDATASTRUCT();
            cds.dwData = new IntPtr(2); // EVERYTHING_IPC_COPYDATAQUERYW
            cds.cbData = size;
            cds.lpData = buf;
            IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(COPYDATASTRUCT)));
            Marshal.StructureToPtr(cds, ptr, false);
            if (!SendMessageW(everythingHwnd, WM_COPYDATA, hwnd, ptr)) ret = 4;
            Marshal.FreeHGlobal(ptr); Marshal.FreeHGlobal(buf);
            // Reply is async relative to our thread: keep the window alive and
            // pump until the reply arrives or the budget runs out.
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < waitMs && !GotReply)
            {
                MSG m;
                while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1))
                {
                    DispatchMessageW(ref m);
                    if (GotReply) break;
                }
                if (GotReply) break;
                Thread.Sleep(5);
            }
        }
        finally { DestroyWindow(hwnd); }
        GC.KeepAlive(proc);
        return ret;
    }
}
'@
try { Add-Type -TypeDefinition $cs -ErrorAction Stop } catch {
  # 重复加载（同进程再次调用）时类型已存在，忽略
  if (-not ('EsIpc' -as [type])) { Write-Error $_; exit 5 }
}

$ret = [EsIpc]::Query($Query, [uint32][Math]::Max(1, $Max), 0, [uint32][Math]::Max(200, $TimeoutMs))
if ($ret -eq 1) { exit 2 }
if ($ret -ne 0) { exit 4 }
if (-not [EsIpc]::GotReply) { exit 3 }
foreach ($path in [EsIpc]::Results) { [Console]::Out.WriteLine($path) }
[Console]::Out.Flush()
exit 0
