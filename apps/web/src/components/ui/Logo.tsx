import React from 'react';

interface LogoProps {
  className?: string;
  size?: number;
  showText?: boolean;
  subtitle?: string;
}

export function Logo({
  className = '',
  size = 32,
  showText = false,
  subtitle = 'trading · agent',
}: LogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
      >
        {/* Left vertical stem with top serif */}
        <path
          d="M30 75 V28 H42"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Right vertical stem with bottom serif */}
        <path
          d="M70 25 V72 H58"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Trading Trend Arrow */}
        <path d="M22 78 L78 22" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
        {/* Arrow Head */}
        <path
          d="M60 22 H78 V40"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Neural Network Node */}
        <circle cx="50" cy="50" r="9" fill="currentColor" />
        <circle cx="50" cy="50" r="4.5" fill="var(--background)" className="fill-background" />
      </svg>
      {showText && (
        <div className="flex flex-col justify-center">
          <div className="text-sm font-semibold leading-tight tracking-tight font-sans">
            OpenNeoTrader
          </div>
          <div className="text-[10px] text-muted-foreground leading-none mt-0.5 font-mono">
            {subtitle}
          </div>
        </div>
      )}
    </div>
  );
}

export default Logo;
