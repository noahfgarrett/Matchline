using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// A Windows Job Object that kills whatever is in it when its last handle
    /// closes.
    /// <para>
    /// The launcher's own cleanup covers every way it can decide to stop:
    /// a cancel line, a stall, an end record. It cannot cover the one way it
    /// does not decide anything -- being terminated itself. On Windows a killed
    /// parent is a `TerminateProcess`, which runs no `finally` and sends no
    /// cancel, and the headless Navisworks it started would go on holding a
    /// licence, gigabytes of RAM and a write handle on a stream file nobody is
    /// reading any more (the audit's "orphaned Navisworks on quit").
    /// </para>
    /// <para>
    /// A job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the only thing
    /// the operating system will do about that on the launcher's behalf: the
    /// handle dies with the process however it dies, and Windows then kills
    /// every process assigned to the job.
    /// </para>
    /// <para>
    /// Never fatal. A machine where the job cannot be created -- an unusual
    /// policy, a container, an already-jobbed process on a Windows too old to
    /// nest them -- still extracts perfectly well; it merely loses this
    /// backstop, which is worth a warning line and nothing more.
    /// </para>
    /// </summary>
    internal sealed class RoamerJob : IDisposable
    {
        /// <summary>JobObjectExtendedLimitInformation, from winnt.h.</summary>
        private const int JobObjectExtendedLimitInformation = 9;

        /// <summary>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, from winnt.h.</summary>
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        private IntPtr _handle;
        private bool _disposed;

        private RoamerJob(IntPtr handle)
        {
            _handle = handle;
        }

        /// <summary>
        /// Creates the job, or explains why there is none. Never throws and
        /// never returns a half-built job: a null result and a sentence are the
        /// only failure.
        /// </summary>
        internal static RoamerJob TryCreate(out string failure)
        {
            failure = null;
            IntPtr handle = IntPtr.Zero;

            try
            {
                handle = CreateJobObject(IntPtr.Zero, null);
                if (handle == IntPtr.Zero)
                {
                    failure = "CreateJobObject failed: " + LastError();
                    return null;
                }

                JOBOBJECT_EXTENDED_LIMIT_INFORMATION information =
                    new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;

                int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
                IntPtr block = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(
                        information, block, false);
                    if (!SetInformationJobObject(
                            handle, JobObjectExtendedLimitInformation, block, (uint)size))
                    {
                        failure = "SetInformationJobObject failed: " + LastError();
                        CloseHandle(handle);
                        return null;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(block);
                }

                RoamerJob job = new RoamerJob(handle);
                handle = IntPtr.Zero;
                return job;
            }
            catch (Exception ex)
            {
                // DllNotFoundException, EntryPointNotFoundException, a security
                // policy refusing the P/Invoke: all of them mean the same thing
                // to the caller, which is "carry on without the backstop".
                if (handle != IntPtr.Zero)
                {
                    CloseHandle(handle);
                }

                failure = ex.GetType().Name + ": " + ex.Message;
                return null;
            }
        }

        /// <summary>
        /// Puts one already-started process in the job. False, with a sentence,
        /// when it could not be done -- most often because the process had
        /// already exited.
        /// </summary>
        internal bool TryAssign(IntPtr processHandle, out string failure)
        {
            failure = null;
            if (_handle == IntPtr.Zero)
            {
                failure = "The job object has already been closed.";
                return false;
            }

            try
            {
                if (AssignProcessToJobObject(_handle, processHandle))
                {
                    return true;
                }

                failure = "AssignProcessToJobObject failed: " + LastError();
                return false;
            }
            catch (Exception ex)
            {
                failure = ex.GetType().Name + ": " + ex.Message;
                return false;
            }
        }

        /// <summary>
        /// Closes the job handle, which is what kills anything still in it.
        /// Called on every exit path; a run that finished normally has nothing
        /// left in the job and closing it costs nothing.
        /// </summary>
        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            if (_handle == IntPtr.Zero)
            {
                return;
            }

            IntPtr handle = _handle;
            _handle = IntPtr.Zero;
            try
            {
                CloseHandle(handle);
            }
            catch (Exception)
            {
                // Nothing useful is left to do about a handle that will not
                // close, and this runs while a run is being torn down.
            }
        }

        private static string LastError()
        {
            int code = Marshal.GetLastWin32Error();
            try
            {
                return new Win32Exception(code).Message;
            }
            catch (Exception)
            {
                return "Win32 error " + code.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr job, int informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        /// <summary>IO_COUNTERS, from winnt.h. Never read; it is here to make the layout right.</summary>
        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        /// <summary>JOBOBJECT_BASIC_LIMIT_INFORMATION, from winnt.h.</summary>
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        /// <summary>JOBOBJECT_EXTENDED_LIMIT_INFORMATION, from winnt.h.</summary>
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }
}
