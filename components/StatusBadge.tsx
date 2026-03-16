type Props = {
  state: "green" | "grey" | "red";
};

export default function StatusBadge({ state }: Props) {
  if (state === "green") {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-green-100 text-green-800 text-sm font-medium">
        <span className="w-2 h-2 rounded-full bg-green-500"></span>
        Alt normalt
      </span>
    );
  }

  if (state === "grey") {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-sm font-medium">
        <span className="w-2 h-2 rounded-full bg-gray-500"></span>
        System offline
      </span>
    );
  }

  if (state === "red") {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-100 text-red-800 text-sm font-medium">
        <span className="w-2 h-2 rounded-full bg-red-500"></span>
        Trenger sjekk
      </span>
    );
  }

  return null;
}
