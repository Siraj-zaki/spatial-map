package api

import (
	"fmt"

	"github.com/go-playground/validator/v10"
)

var validate = validator.New()

// ValidateStruct runs struct-tag validation and returns a human-readable error.
func ValidateStruct(v any) error {
	if err := validate.Struct(v); err != nil {
		if fe, ok := err.(validator.ValidationErrors); ok && len(fe) > 0 {
			return fmt.Errorf("validation failed on %s", fe[0].Field())
		}
		return fmt.Errorf("validation failed: %w", err)
	}
	return nil
}
