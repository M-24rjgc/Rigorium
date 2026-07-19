import rigoriumMark from '../../../assets/rigorium-mark.svg';

const loadingDotAnimationDelays = ['0s', '0.1s', '0.2s'];

export default function AuthLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="text-center">
        <div className="mb-4 flex justify-center">
          <img src={rigoriumMark} alt="Rigorium" className="h-16 w-16" />
        </div>

        <h1 className="mb-2 text-2xl font-bold text-foreground">Rigorium</h1>

        <div className="flex items-center justify-center space-x-2">
          {loadingDotAnimationDelays.map((delay) => (
            <div
              key={delay}
              className="h-2 w-2 animate-bounce rounded-full bg-blue-500"
              style={{ animationDelay: delay }}
            />
          ))}
        </div>

        <p className="mt-2 text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}
