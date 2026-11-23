// Each helper owns only its own WebView2 descendants. Never enumerate or kill
// unrelated browsers, including those belonging to another DSH process.
#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64, job_time: i64, flags: u32,
        min_working_set: usize, max_working_set: usize,
        active_process_limit: u32, affinity: usize, priority: u32, scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits, io: [u64; 6],
        process_memory: usize, job_memory: usize,
        peak_process_memory: usize, peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
    }
    struct ProcessTree(Handle);
    impl Drop for ProcessTree {
        fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
    }
    pub fn attach() -> Result<(), std::io::Error> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return Err(std::io::Error::last_os_error()); }
            let guard = ProcessTree(job);
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
            if SetInformationJobObject(job, 9, &limits as *const _ as *const c_void,
                std::mem::size_of::<ExtendedLimits>() as u32) == 0
                || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            // Deliberately retain this single handle until OS process teardown.
            // Closing it in a Rust destructor would also terminate this process
            // before its normal exit code and WebView shutdown finish.
            std::mem::forget(guard);
            Ok(())
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn win64_abi_matches_job_limits() {
            assert_eq!(std::mem::size_of::<BasicLimits>(), 64);
            assert_eq!(std::mem::size_of::<ExtendedLimits>(), 144);
        }
    }
}
#[cfg(target_os = "windows")]
pub use windows::attach;
