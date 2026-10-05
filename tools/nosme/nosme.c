// LD_PRELOAD shim: hides SME/SME2 from getauxval(AT_HWCAP2).
// Some ARM64 VMs (e.g. Apple Virtualization) advertise SME but trap SME instructions, which crashes
// Chromium's renderer (SIGILL) as soon as libyuv takes an SME code path. Test-infrastructure only.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/auxv.h>

#ifndef AT_HWCAP2
#define AT_HWCAP2 26
#endif

unsigned long getauxval(unsigned long type) {
  static unsigned long (*real)(unsigned long) = 0;
  if (!real) real = (unsigned long (*)(unsigned long))dlsym(RTLD_NEXT, "getauxval");
  unsigned long v = real(type);
  if (type == AT_HWCAP2) {
    v &= ~(0xffUL << 23);           // SME, SME_I16I64 ... SME_FA64 (bits 23-30)
    v &= ~(~0UL << 37);             // SME2 and later SME/FP8 extensions (bits 37+)
  }
  return v;
}
