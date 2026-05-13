interface CliqueLogoProps {
  size?: number
  className?: string
  monochrome?: boolean
}

export default function CliqueLogo({ size = 20, className, monochrome = false }: CliqueLogoProps) {
  const ink = 'currentColor'
  const accent = monochrome ? 'currentColor' : '#E2B237'
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
      <g stroke={ink} strokeWidth={10} strokeLinecap="round">
        <line x1="50" y1="50" x2="150" y2="50" />
        <line x1="150" y1="50" x2="150" y2="150" />
        <line x1="150" y1="150" x2="50" y2="150" />
        <line x1="50" y1="150" x2="50" y2="50" />
        <line x1="50" y1="50" x2="150" y2="150" />
        <line x1="150" y1="50" x2="50" y2="150" />
      </g>
      <circle cx="50" cy="50" r="15" fill={ink} />
      <circle cx="150" cy="50" r="15" fill={accent} />
      <circle cx="150" cy="150" r="15" fill={ink} />
      <circle cx="50" cy="150" r="15" fill={ink} />
    </svg>
  )
}
