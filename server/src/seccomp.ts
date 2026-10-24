/*
 * The third wall around a boxed plugin: a seccomp filter, handed to bwrap as
 * `--seccomp FD` (see `seccompProbe` in plugin-sandbox.ts for how it reaches
 * the box). A deny list, not an allow list: every syscall runs as before
 * except the handful a plugin never needs that either widen what the kernel
 * exposes to it or are the usual way out of a box. Those return EPERM, so a
 * plugin that works today keeps working and one that reaches for them gets an
 * ordinary error, not a dead process.
 *
 * Assembled here rather than by libseccomp or a prebuilt blob: libseccomp
 * would be a new runtime dependency (bwrap only takes the compiled program),
 * and a blob per arch is bytes nobody reviews next to a script that has to be
 * rerun by hand. The program is ~70 instructions of classic BPF with forward
 * jumps only, so the assembler is the label resolver below and nothing more;
 * a test runs the bytes through an interpreter for every rule.
 *
 * Ceiling: x86_64 and aarch64 only (little-endian, the only ones Bun ships).
 * Any other arch gets no filter and the plugin panel says so.
 */

const LD_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const JEQ = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const JGE = 0x35; // BPF_JMP | BPF_JGE | BPF_K
const JSET = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const RET = 0x06; // BPF_RET | BPF_K

export const RET_KILL_PROCESS = 0x80000000;
export const RET_ALLOW = 0x7fff0000;
export const RET_EPERM = 0x00050000 | 1;
export const RET_ENOSYS = 0x00050000 | 38;

/** `struct seccomp_data` offsets. The low word of an argument is at +0 on a
 *  little-endian arch, which both supported arches are. */
const NR = 0;
const ARCH = 4;
const argLo = (i: number) => 16 + 8 * i;

/** The x32 ABI reuses x86_64's audit arch with this bit set in the number:
 *  without the check below, `0x40000000 | nr` is the classic way around a
 *  deny list keyed on x86_64 numbers. */
const X32_BIT = 0x40000000;

/** CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER
 *  | CLONE_NEWPID | CLONE_NEWNET. (CLONE_NEWTIME shares its bit with CSIGNAL
 *  in clone(), so it only exists for unshare/clone3, both denied outright.) */
const CLONE_NS_FLAGS = 0x7e020000;
const TIOCSTI = 0x5412;
const TIOCLINUX = 0x541c;
const PERSONALITY_QUERY = 0xffffffff;

interface ArchTable {
  audit: number;
  x32Bit: boolean;
  clone: number;
  clone3: number;
  ioctl: number;
  personality: number;
  deny: Record<string, number>;
}

/** Numbers from the kernel's own tables (asm/unistd_64.h for x86_64,
 *  asm-generic/unistd.h for aarch64). Grouped by why, not by number. */
export const ARCHES: Record<string, ArchTable> = {
  x64: {
    audit: 0xc000003e, x32Bit: true, clone: 56, clone3: 435, ioctl: 16, personality: 135,
    deny: {
      // reading or steering another process
      ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, kcmp: 312, pidfd_getfd: 438,
      // loading code into the kernel, or replacing it
      kexec_load: 246, kexec_file_load: 320, init_module: 175, finit_module: 313, delete_module: 176, bpf: 321,
      // large, frequently exploited surfaces a plugin has no use for
      perf_event_open: 298, userfaultfd: 323, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
      keyctl: 250, add_key: 248, request_key: 249,
      // rebuilding the box from inside it
      mount: 165, umount2: 166, pivot_root: 155, chroot: 161, unshare: 272, setns: 308,
      open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
      // reaching a file by handle, past every path check
      open_by_handle_at: 304, name_to_handle_at: 303,
      // the machine's, not the plugin's
      reboot: 169, swapon: 167, swapoff: 168, acct: 163, quotactl: 179, syslog: 103, vhangup: 153,
      settimeofday: 164, clock_settime: 227, clock_adjtime: 305, adjtimex: 159,
      iopl: 172, ioperm: 173, uselib: 134, lookup_dcookie: 212,
    },
  },
  arm64: {
    audit: 0xc00000b7, x32Bit: false, clone: 220, clone3: 435, ioctl: 29, personality: 92,
    deny: {
      ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, kcmp: 272, pidfd_getfd: 438,
      kexec_load: 104, kexec_file_load: 294, init_module: 105, finit_module: 273, delete_module: 106, bpf: 280,
      perf_event_open: 241, userfaultfd: 282, io_uring_setup: 425, io_uring_enter: 426, io_uring_register: 427,
      keyctl: 219, add_key: 217, request_key: 218,
      mount: 40, umount2: 39, pivot_root: 41, chroot: 51, unshare: 97, setns: 268,
      open_tree: 428, move_mount: 429, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
      open_by_handle_at: 265, name_to_handle_at: 264,
      reboot: 142, swapon: 224, swapoff: 225, acct: 89, quotactl: 60, syslog: 116, vhangup: 58,
      settimeofday: 170, clock_settime: 112, clock_adjtime: 266, adjtimex: 171,
      lookup_dcookie: 18,
    },
  },
};

type Target = number | string; // 0 = next instruction, a string = a label
type Ins = { code: number; k: number; jt?: Target; jf?: Target } | { label: string };

/** Resolve labels to forward offsets and lay each `struct sock_filter`
 *  (u16 code, u8 jt, u8 jf, u32 k) out little-endian. */
function assemble(prog: Ins[]): Uint8Array {
  const at = new Map<string, number>();
  const ins: { code: number; k: number; jt?: Target; jf?: Target }[] = [];
  for (const p of prog) {
    if ("label" in p) at.set(p.label, ins.length);
    else ins.push(p);
  }
  const out = new DataView(new ArrayBuffer(ins.length * 8));
  ins.forEach((p, i) => {
    const off = (t: Target | undefined) => {
      if (t === undefined || typeof t === "number") return t ?? 0;
      const to = at.get(t);
      if (to === undefined) throw new Error(`seccomp: no label ${t}`);
      const d = to - i - 1;
      if (d < 0 || d > 255) throw new Error(`seccomp: jump to ${t} out of range (${d})`);
      return d;
    };
    out.setUint16(i * 8, p.code, true);
    out.setUint8(i * 8 + 2, off(p.jt));
    out.setUint8(i * 8 + 3, off(p.jf));
    out.setUint32(i * 8 + 4, p.k >>> 0, true);
  });
  return new Uint8Array(out.buffer);
}

/** The compiled filter for `arch` (a `process.arch` value), or null where
 *  there is no table: no filter beats a wrong one. */
export function seccompProgram(arch: string): Uint8Array | null {
  const t = ARCHES[arch];
  if (!t) return null;
  const prog: Ins[] = [
    // A foreign arch (i386 on x86_64, arm32 on aarch64) has its own numbers
    // this list knows nothing about: the process dies rather than slip past.
    { code: LD_ABS, k: ARCH },
    { code: JEQ, k: t.audit, jf: "kill" },
    { code: LD_ABS, k: NR },
    ...(t.x32Bit ? [{ code: JGE, k: X32_BIT, jt: "eperm" }] : []),
    { code: JEQ, k: t.clone, jt: "clone" },
    { code: JEQ, k: t.ioctl, jt: "ioctl" },
    { code: JEQ, k: t.personality, jt: "personality" },
    // ENOSYS, not EPERM: glibc and musl fall back to clone() on ENOSYS only,
    // and clone()'s flags are a register this filter can read; clone3's are
    // behind a pointer it cannot.
    { code: JEQ, k: t.clone3, jt: "enosys" },
    ...Object.values(t.deny).map((nr) => ({ code: JEQ, k: nr, jt: "eperm" })),
    { code: RET, k: RET_ALLOW },
    // Threads and fork stay; only a new namespace is refused.
    { label: "clone" },
    { code: LD_ABS, k: argLo(0) },
    { code: JSET, k: CLONE_NS_FLAGS, jt: "eperm" },
    { code: RET, k: RET_ALLOW },
    // Pushing keystrokes into, or reprogramming, the terminal the app was
    // started from. The kernel reads the command as 32 bits, so only the low
    // word is compared — high bits set do not slip past.
    { label: "ioctl" },
    { code: LD_ABS, k: argLo(1) },
    { code: JEQ, k: TIOCSTI, jt: "eperm" },
    { code: JEQ, k: TIOCLINUX, jt: "eperm" },
    { code: RET, k: RET_ALLOW },
    // Asking is fine (and the default persona); turning off ASLR or making
    // reads imply exec is not.
    { label: "personality" },
    { code: LD_ABS, k: argLo(0) },
    { code: JEQ, k: PERSONALITY_QUERY, jt: "allow" },
    { code: JEQ, k: 0, jt: "allow", jf: "eperm" },
    { label: "allow" },
    { code: RET, k: RET_ALLOW },
    { label: "eperm" },
    { code: RET, k: RET_EPERM },
    { label: "enosys" },
    { code: RET, k: RET_ENOSYS },
    { label: "kill" },
    { code: RET, k: RET_KILL_PROCESS },
  ];
  return assemble(prog);
}
