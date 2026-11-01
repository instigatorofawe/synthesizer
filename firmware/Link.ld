/* STM32L475/L476: 1 MB flash, 96 KB SRAM1, 32 KB SRAM2. The two RAM blocks are not contiguous in use. */
MEMORY {
    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 1024K
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
    /DISCARD/ : { *(.comment) *(.ARM.attributes) }
}
