CREATE TABLE `site_pools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`strategy` text DEFAULT 'balanced' NOT NULL,
	`enabled` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `site_pools_name_idx` ON `site_pools` (`name`);--> statement-breakpoint
CREATE INDEX `site_pools_enabled_idx` ON `site_pools` (`enabled`);--> statement-breakpoint
CREATE TABLE `site_pool_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pool_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`account_id` integer,
	`token_id` integer,
	`role` text DEFAULT 'primary' NOT NULL,
	`weight` real DEFAULT 1,
	`max_concurrency` integer,
	`daily_budget` real,
	`sort_order` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`pool_id`) REFERENCES `site_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `account_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_pool_members_pool_site_idx` ON `site_pool_members` (`pool_id`,`site_id`);--> statement-breakpoint
CREATE INDEX `site_pool_members_pool_role_idx` ON `site_pool_members` (`pool_id`,`role`,`sort_order`);--> statement-breakpoint
CREATE INDEX `site_pool_members_site_id_idx` ON `site_pool_members` (`site_id`);--> statement-breakpoint
CREATE INDEX `site_pool_members_account_id_idx` ON `site_pool_members` (`account_id`);--> statement-breakpoint
CREATE INDEX `site_pool_members_token_id_idx` ON `site_pool_members` (`token_id`);--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `assignment_mode` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `site_pool_id` integer REFERENCES site_pools(id);--> statement-breakpoint
CREATE INDEX `downstream_api_keys_assignment_mode_idx` ON `downstream_api_keys` (`assignment_mode`);--> statement-breakpoint
CREATE INDEX `downstream_api_keys_site_pool_id_idx` ON `downstream_api_keys` (`site_pool_id`);
