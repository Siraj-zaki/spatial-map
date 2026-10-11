// seed-admin creates (or updates) an admin user and links them as the
// owner of every existing tenant. Run once after the auth migrations to
// claim an existing database for a real user account.
//
// Usage:
//
//	SEED_EMAIL=user@example.com SEED_PASSWORD=secret123 go run ./cmd/seed-admin
//
// If SEED_EMAIL / SEED_PASSWORD are unset the command exits with an error —
// no defaults are baked in so you can't accidentally commit a password by
// running it in CI.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/Siraj-zaki/spatial-map/backend/internal/auth"
	"github.com/Siraj-zaki/spatial-map/backend/internal/config"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/jackc/pgx/v5"
)

func main() {
	email := os.Getenv("SEED_EMAIL")
	password := os.Getenv("SEED_PASSWORD")
	if email == "" || password == "" {
		log.Fatal("SEED_EMAIL and SEED_PASSWORD environment variables are required")
	}

	cfgPath := config.StrEnv("SGV_CONFIG", "")
	cfg, err := config.Load(cfgPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	ctx := context.Background()
	pool, err := db.NewPool(ctx, cfg.Database.URL, cfg.Database.MaxOpenConns, cfg.Database.MaxIdleConns, cfg.Database.ConnMaxLifetime)
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}
	defer pool.Close()

	q := db.New(pool)

	// Upsert user. If they exist, rotate the password (so re-running the
	// command is the way to reset a forgotten admin password).
	hash, err := auth.HashPassword(password)
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}

	var userID int64
	existing, err := q.GetUserByEmail(ctx, email)
	switch {
	case err == nil:
		userID = existing.ID
		// Also stamps password_changed_at, so a rotation here signs out
		// every existing session for this user.
		if _, err := q.UpdateUserPassword(ctx, db.UpdateUserPasswordParams{
			ID:           existing.ID,
			PasswordHash: hash,
		}); err != nil {
			log.Fatalf("failed to update password: %v", err)
		}
		fmt.Printf("updated existing user id=%d email=%s\n", userID, email)
	case errors.Is(err, pgx.ErrNoRows):
		user, err := q.CreateUser(ctx, db.CreateUserParams{
			Email:        email,
			PasswordHash: hash,
		})
		if err != nil {
			log.Fatalf("failed to create user: %v", err)
		}
		userID = user.ID
		fmt.Printf("created user id=%d email=%s\n", userID, email)
	default:
		log.Fatalf("failed to look up user: %v", err)
	}

	// Link to every existing tenant as owner. If the tenant table is empty
	// (fresh DB), create one so the admin has a workspace to land in.
	tenants, err := q.ListTenants(ctx)
	if err != nil {
		log.Fatalf("failed to list tenants: %v", err)
	}
	type tenantSummary struct {
		ID   int64
		Name string
	}
	summaries := make([]tenantSummary, 0, len(tenants)+1)
	for _, t := range tenants {
		summaries = append(summaries, tenantSummary{ID: t.ID, Name: t.Name})
	}
	if len(summaries) == 0 {
		tenant, err := q.CreateTenant(ctx, db.CreateTenantParams{
			Name:  "Admin workspace",
			Color: "#3b82f6",
		})
		if err != nil {
			log.Fatalf("failed to create default tenant: %v", err)
		}
		summaries = append(summaries, tenantSummary{ID: tenant.ID, Name: tenant.Name})
		fmt.Printf("created default tenant id=%d name=%q\n", tenant.ID, tenant.Name)
	}

	for _, t := range summaries {
		if _, err := q.AddUserTenant(ctx, db.AddUserTenantParams{
			UserID:   userID,
			TenantID: t.ID,
			Role:     "owner",
		}); err != nil {
			log.Fatalf("failed to link user to tenant %d: %v", t.ID, err)
		}
		fmt.Printf("linked user=%d as owner of tenant id=%d name=%q\n", userID, t.ID, t.Name)
	}
	if err := q.MarkUserVerified(ctx, userID); err != nil {
		log.Fatalf("failed to mark user verified: %v", err)
	}

	fmt.Println("done.")
}
