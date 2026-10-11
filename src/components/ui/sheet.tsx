"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Side-anchored sheet — wraps Radix Dialog with a start/end-anchored
 * panel that slides in from the side. Used for the mobile sidebar
 * drawer on listing routes (data.tsx, files.tsx) where the desktop
 * sidebar would eat too much of the small-screen viewport.
 *
 * Mirrors the shadcn `Sheet` API: `side` prop picks the anchor side,
 * `SheetContent` owns the slide-in animation. Logical properties
 * (`start-0`, `end-0`) keep RTL correct without conditional classes.
 *
 * For the slide animation we use `slide-in-from-left` / `slide-in-from-right`
 * which animate from the physical left/right. In RTL the panel still
 * anchors to the correct physical side via `start-0`/`end-0`, but the
 * slide-in direction follows the physical side too — acceptable for
 * a mobile drawer that opens from the same side as its anchor.
 */
const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close
const SheetPortal = DialogPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName

type SheetSide = "start" | "end" | "top" | "bottom"

const SIDE_POSITIONING: Record<SheetSide, string> = {
  // `start-0` / `end-0` are logical and resolve to left/right based on dir.
  start: "start-0 top-0 h-dvh w-[min(320px,85vw)] rounded-e-xl border-e",
  end: "end-0 top-0 h-dvh w-[min(320px,85vw)] rounded-s-xl border-s",
  top: "inset-x-0 top-0 max-h-[85dvh] rounded-b-xl border-b",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t",
}

const SIDE_ANIMATION: Record<SheetSide, string> = {
  start:
    "data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
  end:
    "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
  top: "data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
  bottom:
    "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
}

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: SheetSide
  /** Hide the default top-end close button when the caller renders its
   *  own close affordance (e.g. a header bar with an X). */
  hideDefaultClose?: boolean
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ className, children, side = "end", hideDefaultClose = false, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 flex flex-col gap-0 bg-background shadow-2xl transition ease-in-out duration-300",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "border p-0",
        SIDE_POSITIONING[side],
        SIDE_ANIMATION[side],
        className
      )}
      {...props}
    >
      {children}
      {!hideDefaultClose && (
        <DialogPrimitive.Close
          className="absolute end-3 top-3 rounded-sm p-1 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = "SheetContent"

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 p-4 border-b flex-shrink-0",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "mt-auto flex flex-col-reverse gap-2 p-4 border-t flex-shrink-0",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-sm font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
SheetTitle.displayName = DialogPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-xs text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = DialogPrimitive.Description.displayName

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}