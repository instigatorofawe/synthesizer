/* QEMU's mps2-an386: a Cortex-M4 like the L475 model, with room for the fuzzer. 4 MB code, 4 MB RAM, 16 MB PSRAM. */
MEMORY {
    CODE (rx)  : ORIGIN = 0x00000000, LENGTH = 4M
    RAM (rwx)  : ORIGIN = 0x20000000, LENGTH = 4M
    PSRAM (rw) : ORIGIN = 0x21000000, LENGTH = 16M
}
ENTRY(reset)
SECTIONS {
    .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) . = ALIGN(8); } > CODE
    .ARM.exidx : { *(.ARM.exidx*) } > CODE
    .data : { *(.data*) . = ALIGN(4); } > RAM
    .bss (NOLOAD) : { __bss_start = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end = .; } > RAM
    __arena_start = ORIGIN(PSRAM);
    __arena_end = ORIGIN(PSRAM) + LENGTH(PSRAM);
    __stack_top = ORIGIN(RAM) + LENGTH(RAM);
    /DISCARD/ : { *(.comment) *(.ARM.attributes) }
}
