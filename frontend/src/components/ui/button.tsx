import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background,color,box-shadow,transform] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-brand text-brand-contrast shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(16_18_23/0.2)] hover:bg-brand-hover",
        secondary: "bg-surface text-fg shadow-e1 hover:bg-surface-2",
        ghost: "text-muted hover:bg-surface-2 hover:text-fg",
        subtle: "bg-surface-2 text-fg hover:bg-surface-3",
        outline: "border border-border-strong bg-transparent text-fg hover:bg-surface-2",
        danger: "bg-notmet text-white hover:opacity-90",
        ai: "ai-gradient text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_20px_-6px_color-mix(in_oklab,var(--ai-2)_60%,transparent)] hover:brightness-110",
        link: "h-auto px-0 text-brand underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-7 rounded-sm px-2 text-xs [&_svg]:size-3.5",
        sm: "h-8 rounded-md px-2.5 text-[13px]",
        md: "h-9 rounded-md px-3.5 text-sm",
        lg: "h-11 rounded-lg px-5 text-[15px]",
        icon: "size-8 rounded-md",
        "icon-sm": "size-7 rounded-sm [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";
