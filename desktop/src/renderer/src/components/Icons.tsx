import type { SVGProps } from "react";

export type IconName =
    | "arrow-up"
    | "branch"
    | "check"
    | "chevron-down"
    | "chevron-right"
    | "close"
    | "document"
    | "image"
    | "panel-left"
    | "panel-right"
    | "plus"
    | "refresh"
    | "search"
    | "shield"
    | "sliders";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "name"> {
    name: IconName;
    size?: number;
}

export function Icon({ name, size = 16, ...props }: IconProps) {
    const common = {
        width: size,
        height: size,
        viewBox: "0 0 18 18",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.4,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
        "aria-hidden": true,
        ...props,
    };

    switch (name) {
        case "arrow-up":
            return (
                <svg {...common}>
                    <line x1="9" y1="13.8" x2="9" y2="4.6" />
                    <path d="M5 8.6 9 4.6l4 4" />
                </svg>
            );
        case "branch":
            return (
                <svg {...common}>
                    <circle cx="6" cy="5" r="1.8" />
                    <circle cx="6" cy="13.2" r="1.8" />
                    <circle cx="12.6" cy="8.2" r="1.8" />
                    <path d="M6 6.8v4.6M7.8 5h2.3a2.5 2.5 0 0 1 2.5 2.5" />
                </svg>
            );
        case "check":
            return (
                <svg {...common}>
                    <path d="m4.2 9.3 3 3 6.6-6.6" strokeWidth="1.7" />
                </svg>
            );
        case "chevron-down":
            return (
                <svg {...common}>
                    <path d="M5.5 7.5 9 11l3.5-3.5" />
                </svg>
            );
        case "chevron-right":
            return (
                <svg {...common}>
                    <path d="m7 4.5 4.5 4.5L7 13.5" />
                </svg>
            );
        case "close":
            return (
                <svg {...common}>
                    <path d="m5 5 8 8M13 5l-8 8" />
                </svg>
            );
        case "document":
            return (
                <svg {...common}>
                    <path d="M4.5 3.5h5L13 7v7.5H4.5zM9.5 3.5V7H13" />
                </svg>
            );
        case "image":
            return (
                <svg {...common}>
                    <rect x="3" y="4" width="12" height="10" rx="2.5" />
                    <circle cx="6.9" cy="7.8" r="1.1" />
                    <path d="m3.4 12.8 3.9-3.4 2.9 2.6 2-1.7 2.6 2.3" />
                </svg>
            );
        case "panel-left":
            return (
                <svg {...common}>
                    <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
                    <line x1="6.7" y1="3.5" x2="6.7" y2="14.5" />
                </svg>
            );
        case "panel-right":
            return (
                <svg {...common}>
                    <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
                    <line x1="11.3" y1="3.5" x2="11.3" y2="14.5" />
                </svg>
            );
        case "plus":
            return (
                <svg {...common}>
                    <path d="M9 4.2v9.6M4.2 9h9.6" />
                </svg>
            );
        case "refresh":
            return (
                <svg {...common}>
                    <path d="M14.5 9a5.5 5.5 0 1 1-2.1-4.3M14.6 3.6v3.1h-3.1" />
                </svg>
            );
        case "search":
            return (
                <svg {...common}>
                    <circle cx="8" cy="8" r="4.2" />
                    <line x1="11.3" y1="11.3" x2="14.2" y2="14.2" />
                </svg>
            );
        case "shield":
            return (
                <svg {...common}>
                    <path d="M9 3.2 14 5v4.3c0 2.9-2 5-5 5.8-3-.8-5-2.9-5-5.8V5z" />
                </svg>
            );
        case "sliders":
            return (
                <svg {...common}>
                    <path d="M3 6.5h12M3 11.5h12" />
                    <circle cx="7" cy="6.5" r="1.7" fill="var(--shell)" />
                    <circle cx="11.5" cy="11.5" r="1.7" fill="var(--shell)" />
                </svg>
            );
    }
}
