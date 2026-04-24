CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_message_id` text,
	`intent` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`parent_message_id`) REFERENCES `message`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `message_session_idx` ON `message` (`session_id`);--> statement-breakpoint
CREATE INDEX `message_intent_idx` ON `message` (`intent`);--> statement-breakpoint
CREATE INDEX `message_parent_message_idx` ON `message` (`parent_message_id`);--> statement-breakpoint
CREATE INDEX `message_session_parent_message_idx` ON `message` (`session_id`,`parent_message_id`);--> statement-breakpoint
CREATE TABLE `part` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `part_message_idx` ON `part` (`message_id`);--> statement-breakpoint
CREATE INDEX `part_session_idx` ON `part` (`session_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree` text DEFAULT '/' NOT NULL,
	`vcs` text,
	`repo` text,
	`name` text,
	`icon_url` text,
	`icon_color` text,
	`initialized_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_session_id` text,
	`active_leaf_message_id` text,
	`cwd` text NOT NULL,
	`name` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `session`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`active_leaf_message_id`) REFERENCES `message`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_project_idx` ON `session` (`project_id`);--> statement-breakpoint
CREATE INDEX `session_parent_session_idx` ON `session` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `session_active_leaf_message_idx` ON `session` (`active_leaf_message_id`);