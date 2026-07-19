import type { ReactNode } from 'react';
import rigoriumMark from '../../../assets/rigorium-mark.svg';

type AuthScreenLayoutProps = {
  title: string;
  description: string;
  children: ReactNode;
  footerText: string;
  logo?: ReactNode;
};

export default function AuthScreenLayout({
  title,
  description,
  children,
  footerText,
  logo,
}: AuthScreenLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="space-y-6 rounded-lg border border-border bg-card p-8 shadow-lg">
          <div className="text-center">
            <div className="mb-4 flex justify-center">
              {logo ?? <img src={rigoriumMark} alt="Rigorium" className="h-16 w-16" />}
            </div>
            <h1 className="text-2xl font-bold text-foreground">{title}</h1>
            <p className="mt-2 text-muted-foreground">{description}</p>
          </div>

          {children}

          <div className="text-center">
            <p className="text-sm text-muted-foreground">{footerText}</p>
          </div>

        </div>
      </div>
    </div>
  );
}
