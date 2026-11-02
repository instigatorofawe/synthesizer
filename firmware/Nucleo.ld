/* NUCLEO-L476RG: 1 MB flash in two banks of 512 KB, 96 KB SRAM1 and 32 KB SRAM2. The firmware takes the start of bank 1
   and slot A the rest of it, from __slot_a, which CMake defines from MODSYNTH_SLOT_KB. Slot B starts bank 2. */
MEMORY {
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K
    SRAM1 (rwx) : ORIGIN = 0x20000000, LENGTH = 96K
    SRAM2 (rwx) : ORIGIN = 0x10000000, LENGTH = 32K
}
ENTRY(reset)
SECTIONS {
    .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) . = ALIGN(8); } > FLASH
    .ARM.exidx : { *(.ARM.exidx*) } > FLASH
    __data_load = LOADADDR(.data);
    .data : { __data_start = .; *(.data*) . = ALIGN(4); __data_end = .; } > SRAM1 AT > FLASH
    .bss (NOLOAD) : { __bss_start = .; *(.bss*) *(COMMON) . = ALIGN(4); __bss_end = .; } > SRAM1
    .sram2 (NOLOAD) : { *(.sram2*) } > SRAM2
    __stack_top = ORIGIN(SRAM1) + LENGTH(SRAM1);
    ASSERT(__stack_top - __bss_end >= 8K, "less than 8 KB is left for the stack")
    ASSERT(__data_load + SIZEOF(.data) <= __slot_a, "the firmware runs into slot A: make MODSYNTH_SLOT_KB smaller")
    .profile 0 (INFO) : { KEEP(*(.profile)) }  /* the target profile, for the build to extract */
    /DISCARD/ : { *(.comment) *(.ARM.attributes) }
}
