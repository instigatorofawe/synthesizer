CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`encoding` text NOT NULL,
	`channels` integer NOT NULL,
	`rate` integer NOT NULL,
	`frames` integer NOT NULL,
	`root_key` integer DEFAULT 60 NOT NULL,
	`loop_start` integer DEFAULT 0 NOT NULL,
	`loop_end` integer DEFAULT 0 NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bundle_timelines` (
	`bundle_id` text NOT NULL,
	`timeline_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`bundle_id`, `timeline_id`),
	FOREIGN KEY (`bundle_id`) REFERENCES `bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `patch_assets` (
	`patch_id` text NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`patch_id`, `asset_id`),
	FOREIGN KEY (`patch_id`) REFERENCES `patches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `patches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`graph` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `timeline_patches` (
	`timeline_id` text NOT NULL,
	`patch_id` text NOT NULL,
	PRIMARY KEY(`timeline_id`, `patch_id`),
	FOREIGN KEY (`timeline_id`) REFERENCES `timelines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`patch_id`) REFERENCES `patches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `timelines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`doc` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
