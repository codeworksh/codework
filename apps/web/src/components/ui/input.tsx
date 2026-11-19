import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// A compact field for settings and dialogs; `lg` stands alone as a page's main field.
const inputVariants = cva(
	"w-full min-w-0 border border-input bg-transparent py-1 text-ui shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
	{
		variants: {
			size: {
				default: "h-7 rounded-lg px-2.5",
				lg: "h-11 rounded-xl px-3",
			},
		},
		defaultVariants: { size: "default" },
	},
);

function Input({
	className,
	type,
	size,
	...props
}: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
	return (
		<input
			type={type}
			data-slot="input"
			data-size={size ?? "default"}
			className={cn(
				inputVariants({ size }),
				"focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				"aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
