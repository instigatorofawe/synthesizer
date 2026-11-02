CREATE TABLE `patch_subpatches` (
	`patch_id` text NOT NULL,
	`subpatch_id` text NOT NULL,
	PRIMARY KEY(`patch_id`, `subpatch_id`),
	FOREIGN KEY (`patch_id`) REFERENCES `patches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subpatch_id`) REFERENCES `patches`(`id`) ON UPDATE no action ON DELETE restrict
);
