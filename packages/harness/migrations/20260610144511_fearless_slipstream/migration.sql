CREATE TABLE `project_directory` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`type` text NOT NULL,
	`sandbox_env_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE CASCADE ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`vcs` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_directory_project_directory_idx` ON `project_directory` (`project_id`,`directory`);