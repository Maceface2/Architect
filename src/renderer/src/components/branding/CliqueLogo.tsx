interface CliqueLogoProps {
  size?: number
  className?: string
  /** Kept for API compatibility with existing call sites. The triangle mark
      uses fixed brand colors (white ink + yellow top node) and is
      intentionally not themed. */
  monochrome?: boolean
}

export default function CliqueLogo({ size = 20, className }: CliqueLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      role="img"
      aria-label="Clique"
      className={className}
    >
      <g transform="translate(100, 110)">
        <g stroke="#ffffff" strokeWidth={2.5} strokeLinecap="round">
          {/* Triangle perimeter */}
          <line x1="0" y1="-65" x2="-60" y2="40" />
          <line x1="0" y1="-65" x2="60" y2="40" />
          <line x1="-60" y1="40" x2="60" y2="40" />
          {/* Spokes to center */}
          <line x1="0" y1="-65" x2="0" y2="5" />
          <line x1="-60" y1="40" x2="0" y2="5" />
          <line x1="60" y1="40" x2="0" y2="5" />
        </g>
        <circle cx="0" cy="-65" r="8" fill="#e8c547" />
        <circle cx="-60" cy="40" r="8" fill="#ffffff" />
        <circle cx="60" cy="40" r="8" fill="#ffffff" />
        <circle cx="0" cy="5" r="8" fill="#ffffff" />
      </g>
    </svg>
  )
}
