import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../../lib/utils';

type SettingsSectionProps = HTMLAttributes<HTMLDivElement> & {
  // ReactNode so callers can inline a small icon next to the title (the
  // Permissions tab leans on this for its alert/shield glyphs).
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
};

export default function SettingsSection({ title, description, children, className, ...rest }: SettingsSectionProps) {
  return (
    <div className={cn('space-y-2.5', className)} {...rest}>
      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}
