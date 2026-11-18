// Classic BPF for Linux seccomp. No native dependency or compiler is required.
// Block host filesystem Unix sockets when networking is disabled. Network
// namespaces alone do not isolate pathname AF_UNIX sockets in bind mounts.
export function socketFilter(arch = process.arch) {
  const abi = { x64: { arch: 0xc000003e, socket: 41, uring: [425, 426, 427] }, arm64: { arch: 0xc00000b7, socket: 198, uring: [425, 426, 427] } }[arch];
  if (!abi) throw Error(`No socket isolation filter for Linux ${arch}`);
  const instructions = [];
  const ins = (code, jt, jf, k) => instructions.push({ code, jt, jf, k });
  ins(0x20, 0, 0, 4); // seccomp_data.arch
  ins(0x15, 1, 0, abi.arch);
  ins(0x06, 0, 0, 0x80000000); // kill incompatible ABI, including 32-bit socketcall
  ins(0x20, 0, 0, 0); // syscall number
  ins(0x45, 0, 1, 0x40000000); // deny x32 ABI
  ins(0x06, 0, 0, 0x00050001); // EPERM
  for (const syscall of abi.uring) { ins(0x15, 0, 1, syscall); ins(0x06, 0, 0, 0x00050001); }
  ins(0x15, 0, 3, abi.socket);
  ins(0x20, 0, 0, 16); // socket domain (first argument)
  ins(0x15, 0, 1, 1); // AF_UNIX
  ins(0x06, 0, 0, 0x00050001);
  ins(0x06, 0, 0, 0x7fff0000); // allow
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach((instruction, index) => { buffer.writeUInt16LE(instruction.code, index * 8); buffer[index * 8 + 2] = instruction.jt; buffer[index * 8 + 3] = instruction.jf; buffer.writeUInt32LE(instruction.k, index * 8 + 4); });
  return buffer;
}
