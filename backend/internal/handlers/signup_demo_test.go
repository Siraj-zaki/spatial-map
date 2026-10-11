package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/Siraj-zaki/spatial-map/backend/internal/auth"
	"github.com/Siraj-zaki/spatial-map/backend/internal/handlers"
	"github.com/Siraj-zaki/spatial-map/backend/internal/mailer"
	"github.com/stretchr/testify/require"
)

// TestCompleteSignup_JoinsDemoWorkspace guards the demo workspace's
// promise (internal/demo): a new account lands in it as an editor, first
// in the list, and can see its reports — editors see a report only with
// a grant.
func TestCompleteSignup_JoinsDemoWorkspace(t *testing.T) {
	if os.Getenv("CI") != "" && os.Getenv("RUN_INTEGRATION") != "true" {
		t.Skip("integration tests disabled in CI unless RUN_INTEGRATION=true")
	}
	ctx := context.Background()
	q, pool, _, cleanup := setupTestDB(t, ctx)
	defer cleanup()

	const secret = "test-jwt-secret"
	router := handlers.AuthRouter(q, pool, secret, mailer.New(mailer.Config{}))

	signup := func(email string) handlers.AuthResponse {
		t.Helper()
		token, err := auth.IssueVerificationToken(secret, email, "signup", 10*time.Minute)
		require.NoError(t, err)
		body, _ := json.Marshal(map[string]string{
			"email": email, "password": "Quartz-Ferry-Lantern-82", "verificationToken": token,
		})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/complete-signup", bytes.NewReader(body)))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var env struct {
			Data handlers.AuthResponse `json:"data"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
		return env.Data
	}

	// Without a demo workspace: just the user's own.
	before := signup("first@example.com")
	require.Len(t, before.Tenants, 1)

	var demoID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO tenants (name, color, is_demo) VALUES ('Demo workspace', '#0ea5e9', true) RETURNING id`).Scan(&demoID))
	var reportID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO reports (tenant_id, name, spec) VALUES ($1, 'Overview', '{}') RETURNING id`, demoID).Scan(&reportID))

	after := signup("second@example.com")
	require.Len(t, after.Tenants, 2)
	require.Equal(t, demoID, after.Tenants[0].ID)
	require.Equal(t, handlers.RoleEditor, after.Tenants[0].Role)
	require.Equal(t, handlers.RoleOwner, after.Tenants[1].Role)

	grants, err := q.ListReportIDsVisibleToUser(ctx, after.User.ID)
	require.NoError(t, err)
	require.Len(t, grants, 1)
	require.Equal(t, reportID, grants[0].ReportID)
	require.False(t, grants[0].CanEdit)
}
