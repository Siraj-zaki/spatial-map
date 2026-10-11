package handlers

import (
	"errors"
	"net/http"
	"strings"

	"github.com/Siraj-zaki/spatial-map/backend/internal/api"
	"github.com/Siraj-zaki/spatial-map/backend/internal/db"
	"github.com/Siraj-zaki/spatial-map/backend/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// Profile-field length caps. Long enough for any real input but bounded so
// a misbehaving client can't DOS the DB with multi-MB strings.
const (
	maxDisplayName = 80
	maxBio         = 1000
	maxLocation    = 120
	maxPronouns    = 40
	maxJobTitle    = 120
)

const maxAvatarBytes = 5 * 1024 * 1024 // 5 MB

// ProfileUpdateRequest is the body for PATCH /api/v1/profile. All fields
// are optional in the JSON wire sense — empty strings clear the value.
type ProfileUpdateRequest struct {
	DisplayName string `json:"displayName"`
	Bio         string `json:"bio"`
	Location    string `json:"location"`
	Pronouns    string `json:"pronouns"`
	JobTitle    string `json:"jobTitle"`
}

// ProfileRouter mounts user-profile self-service endpoints. Authenticated
// (JWT required) but NOT tenant-scoped — profile data is per-user.
func ProfileRouter(q *db.Queries, s store.ObjectStore) chi.Router {
	r := chi.NewRouter()
	r.Get("/", getProfile(q))
	r.Patch("/", updateProfile(q))
	r.Post("/avatar", uploadAvatar(q, s))
	return r
}

func getProfile(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := api.UserID(r.Context())
		if userID == 0 {
			api.Error(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		user, err := q.GetUserByID(r.Context(), userID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.Error(w, http.StatusUnauthorized, "user no longer exists")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toAuthUser(user))
	}
}

func updateProfile(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := api.UserID(r.Context())
		if userID == 0 {
			api.Error(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		var req ProfileUpdateRequest
		if err := api.DecodeBody(r, &req); err != nil {
			api.BadRequest(w, "invalid request body")
			return
		}
		req.DisplayName = strings.TrimSpace(req.DisplayName)
		req.Bio = strings.TrimSpace(req.Bio)
		req.Location = strings.TrimSpace(req.Location)
		req.Pronouns = strings.TrimSpace(req.Pronouns)
		req.JobTitle = strings.TrimSpace(req.JobTitle)

		if len(req.DisplayName) > maxDisplayName {
			api.BadRequest(w, "display name too long")
			return
		}
		if len(req.Bio) > maxBio {
			api.BadRequest(w, "bio too long")
			return
		}
		if len(req.Location) > maxLocation {
			api.BadRequest(w, "location too long")
			return
		}
		if len(req.Pronouns) > maxPronouns {
			api.BadRequest(w, "pronouns too long")
			return
		}
		if len(req.JobTitle) > maxJobTitle {
			api.BadRequest(w, "job title too long")
			return
		}

		user, err := q.UpdateUserProfile(r.Context(), db.UpdateUserProfileParams{
			ID:          userID,
			DisplayName: req.DisplayName,
			Bio:         req.Bio,
			Location:    req.Location,
			Pronouns:    req.Pronouns,
			JobTitle:    req.JobTitle,
		})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				api.Error(w, http.StatusUnauthorized, "user no longer exists")
				return
			}
			api.InternalError(w, r, err)
			return
		}
		api.JSON(w, http.StatusOK, toAuthUser(user))
	}
}

func uploadAvatar(q *db.Queries, s store.ObjectStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := api.UserID(r.Context())
		if userID == 0 {
			api.Error(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		// 5 MB cap on the multipart form so a runaway upload can't fill memory.
		if err := r.ParseMultipartForm(maxAvatarBytes); err != nil {
			api.BadRequest(w, "invalid multipart form")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			api.BadRequest(w, "missing file")
			return
		}
		defer file.Close()

		// Reject non-image MIME types early — the storage layer will accept
		// anything, but the frontend's <img> will fail for non-images.
		contentType := header.Header.Get("Content-Type")
		if !strings.HasPrefix(contentType, "image/") {
			api.BadRequest(w, "file must be an image")
			return
		}

		data, err := store.ReadAll(file)
		if err != nil {
			api.InternalError(w, r, err)
			return
		}
		if int64(len(data)) > maxAvatarBytes {
			api.BadRequest(w, "image is too large (max 5 MB)")
			return
		}

		// Capture the previous avatar URL BEFORE the row is updated so we
		// can reclaim its file after the new one is committed. A missing
		// row (deleted concurrently) is not fatal — the update will 404
		// and no cleanup is needed.
		previousAvatarURL, _ := q.GetUserAvatarURL(r.Context(), userID)

		key := store.KeyFromData(header.Filename, data)
		if err := s.Put(r.Context(), key, contentType, data); err != nil {
			api.InternalError(w, r, err)
			return
		}
		newAvatarURL := store.NormalizeAssetURL(s.URL(key))

		user, err := q.UpdateUserAvatar(r.Context(), db.UpdateUserAvatarParams{
			ID: userID,
			// Strip any absolute-host prefix before persisting — see
			// `store.NormalizeAssetURL` for the historic bug.
			AvatarUrl: newAvatarURL,
		})
		if err != nil {
			api.InternalError(w, r, err)
			return
		}

		// Physically reclaim the previous avatar file if it's different
		// from the newly-committed one AND no other row references it
		// (unlikely for avatars but the helper is defensive). Same-URL
		// reupload of identical bytes intentionally does nothing —
		// content-addressed keys mean the URL didn't change.
		if previousAvatarURL != "" && previousAvatarURL != newAvatarURL {
			cleanupObjectURLs(r.Context(), q, s, []string{previousAvatarURL})
		}

		api.JSON(w, http.StatusOK, toAuthUser(user))
	}
}
