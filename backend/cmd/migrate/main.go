package main

import (
	"fmt"
	"os"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: migrate [up|down|version]")
		os.Exit(1)
	}

	dbURL := os.Getenv("SGV_DATABASE.URL")
	if dbURL == "" {
		fmt.Fprintln(os.Stderr, "SGV_DATABASE.URL is required")
		os.Exit(1)
	}

	migrationsPath := os.Getenv("SGV_MIGRATION.PATH")
	if migrationsPath == "" {
		migrationsPath = "migrations"
	}

	sourceURL := fmt.Sprintf("file://%s", migrationsPath)
	m, err := migrate.New(sourceURL, dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to create migrate instance: %v\n", err)
		os.Exit(1)
	}

	switch os.Args[1] {
	case "up":
		if err := m.Up(); err != nil && err != migrate.ErrNoChange {
			fmt.Fprintf(os.Stderr, "migrate up failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("migrations applied")
	case "down":
		if err := m.Down(); err != nil && err != migrate.ErrNoChange {
			fmt.Fprintf(os.Stderr, "migrate down failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("migrations rolled back")
	case "version":
		v, dirty, err := m.Version()
		if err != nil {
			fmt.Fprintf(os.Stderr, "version failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("version: %d, dirty: %v\n", v, dirty)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}
