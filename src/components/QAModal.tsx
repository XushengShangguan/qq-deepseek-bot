"use client";

import { Fragment, FormEvent, useEffect, useRef, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { useCompletion } from "ai/react";

type Line = { role: "user" | "assistant" | "error"; text: string };

export default function QAModal({
  open,
  setOpen,
  example,
}: {
  open: boolean;
  setOpen: any;
  example: any;
}) {
  const name: string = example?.name || "";
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { completion, input, setInput, handleInputChange, complete, isLoading, stop, setCompletion } =
    useCompletion({
      api: "/api/chat",
      headers: { name },
      onFinish: (prompt, result) => {
        setLines((l) => [
          ...l,
          { role: "user", text: prompt },
          { role: "assistant", text: result },
        ]);
        setPending(null);
        setCompletion("");
      },
      onError: (err) => {
        setLines((l) => [
          ...l,
          ...(pending ? [{ role: "user" as const, text: pending }] : []),
          { role: "error", text: err.message || "出错了" },
        ]);
        setPending(null);
      },
    });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, completion, pending]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setPending(text);
    setInput("");
    complete(text);
  };

  const handleClose = () => {
    stop();
    setInput("");
    setCompletion("");
    setPending(null);
    setLines([]);
    setOpen(false);
  };

  const bubble = (line: Line, key: number | string) => (
    <div
      key={key}
      className={"flex " + (line.role === "user" ? "justify-end" : "justify-start")}
    >
      <p
        className={
          "max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm " +
          (line.role === "user"
            ? "bg-sky-700 text-white"
            : line.role === "error"
            ? "bg-red-900/60 text-red-200"
            : "bg-gray-700 text-gray-100")
        }
      >
        {line.text}
      </p>
    </div>
  );

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog as="div" className="relative z-10" onClose={handleClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-950 bg-opacity-75 transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative transform overflow-hidden rounded-lg bg-gray-800 px-4 pb-4 pt-5 text-left shadow-xl transition-all sm:my-8 sm:p-6 w-full max-w-3xl">
                <p className="text-sm text-gray-400">和 {name} 聊天</p>
                <div className="mt-3 flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
                  {lines.map((line, i) => bubble(line, i))}
                  {pending && bubble({ role: "user", text: pending }, "pending")}
                  {pending &&
                    bubble(
                      { role: "assistant", text: completion || "…" },
                      "streaming"
                    )}
                  <div ref={bottomRef} />
                </div>
                <form onSubmit={handleSubmit} className="mt-4">
                  <input
                    placeholder="今天过得怎么样？"
                    className="w-full flex-auto rounded-md border-0 bg-white/5 px-3.5 py-2 text-white shadow-sm focus:outline-none sm:text-sm sm:leading-6"
                    value={input}
                    onChange={handleInputChange}
                    autoFocus
                  />
                </form>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
