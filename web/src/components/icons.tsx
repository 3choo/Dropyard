import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconUpload = (p: P) => (
  <Icon {...p}>
    <path d="M12 16V4m0 0L7 9m5-5 5 5" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Icon>
);

export const IconDownload = (p: P) => (
  <Icon {...p}>
    <path d="M12 4v12m0 0 5-5m-5 5-5-5" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Icon>
);

export const IconPause = (p: P) => (
  <Icon {...p}>
    <path d="M9 5v14M15 5v14" />
  </Icon>
);

export const IconPlay = (p: P) => (
  <Icon {...p}>
    <path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconX = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const IconSearch = (p: P) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const IconChevronDown = (p: P) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const IconChevronRight = (p: P) => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const IconFolder = (p: P) => (
  <Icon {...p}>
    <path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </Icon>
);

export const IconFile = (p: P) => (
  <Icon {...p}>
    <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9z" />
    <path d="M13 3v6h5" />
  </Icon>
);

export const IconTerminal = (p: P) => (
  <Icon {...p}>
    <path d="m5 8 4 4-4 4" />
    <path d="M12 16h7" />
  </Icon>
);

export const IconSettings = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10L4.9 19.1" />
  </Icon>
);

export const IconTrash = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" />
  </Icon>
);

export const IconUsers = (p: P) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.4a6.5 6.5 0 0 1 4 5.6" />
  </Icon>
);

export const IconKey = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8-8m-2 0h3v3" />
  </Icon>
);

export const IconActivity = (p: P) => (
  <Icon {...p}>
    <path d="M3 12h4l2.5-6 4 12L16 12h5" />
  </Icon>
);

export const IconLogout = (p: P) => (
  <Icon {...p}>
    <path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" />
    <path d="m15 8 4 4-4 4M19 12H9" />
  </Icon>
);

export const IconArrowLeft = (p: P) => (
  <Icon {...p}>
    <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
  </Icon>
);

export const IconCheck = (p: P) => (
  <Icon {...p}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Icon>
);

export const IconAlert = (p: P) => (
  <Icon {...p}>
    <path d="M12 3 2.5 20h19z" />
    <path d="M12 10v4m0 3v.01" />
  </Icon>
);

export const IconCopy = (p: P) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </Icon>
);

export const IconLayers = (p: P) => (
  <Icon {...p}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </Icon>
);
