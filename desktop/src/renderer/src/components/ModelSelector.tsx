import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";

export interface ModelOption {
    id: string;
    provider: string;
    name?: string;
}

export function ModelSelector({
    models,
    value,
    disabled,
    onChange,
}: {
    models: ModelOption[];
    value: string;
    disabled: boolean;
    onChange(value: string): void;
}) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = useId();
    const groups = useMemo(() => {
        const grouped = new Map<string, ModelOption[]>();
        for (const model of models) {
            grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
        }

        return [...grouped.entries()];
    }, [models]);
    const orderedModels = useMemo(() => groups.flatMap(([, options]) => options), [groups]);
    const current = models.find((model) => `${model.provider}/${model.id}` === value);
    const currentIndex = Math.max(
        0,
        orderedModels.findIndex((model) => `${model.provider}/${model.id}` === value),
    );

    const focusOption = (index: number) => {
        const bounded = Math.min(Math.max(0, index), orderedModels.length - 1);
        requestAnimationFrame(() => optionRefs.current[bounded]?.focus());
    };

    const openAndFocus = (index = currentIndex) => {
        if (disabled || orderedModels.length === 0) {
            return;
        }

        setOpen(true);
        focusOption(index);
    };

    useEffect(() => {
        if (!open) {
            return;
        }

        const onPointerDown = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
            }
        };

        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    useEffect(() => {
        if (disabled) {
            setOpen(false);
        }
    }, [disabled]);

    return (
        <div className={`model-picker model-select${open ? " open" : ""}`} ref={root}>
            <button
                ref={trigger}
                className="model-trigger"
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={menuId}
                onClick={() => {
                    if (open) {
                        setOpen(false);
                    } else {
                        openAndFocus();
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        openAndFocus(event.key === "ArrowDown" ? currentIndex : orderedModels.length - 1);
                    }
                }}
            >
                <span>{current?.name || current?.id || value.split("/").at(-1) || "Model"}</span>
                <Icon name="chevron-down" size={12} />
            </button>
            <div
                className={`model-menu${open ? " open" : ""}`}
                id={menuId}
                role="listbox"
                aria-label="Model"
                aria-hidden={!open}
                inert={open ? undefined : true}
            >
                <header>
                    <span>Models</span>
                    <small>{models.length} available</small>
                </header>
                <div className="model-options">
                    {groups.map(([provider, options]) => (
                        <div className="model-group" role="group" aria-label={provider} key={provider}>
                            <span>{provider}</span>
                            {options.map((model) => {
                                const optionValue = `${model.provider}/${model.id}`;
                                const index = orderedModels.indexOf(model);
                                const selected = optionValue === value;

                                return (
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        tabIndex={open ? 0 : -1}
                                        ref={(node) => {
                                            optionRefs.current[index] = node;
                                        }}
                                        className={selected ? "active" : ""}
                                        key={optionValue}
                                        onClick={() => {
                                            setOpen(false);
                                            onChange(optionValue);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                                event.preventDefault();
                                                const offset = event.key === "ArrowDown" ? 1 : -1;
                                                focusOption(
                                                    (index + offset + orderedModels.length) % orderedModels.length,
                                                );
                                            } else if (event.key === "Home" || event.key === "End") {
                                                event.preventDefault();
                                                focusOption(event.key === "Home" ? 0 : orderedModels.length - 1);
                                            } else if (event.key === "Tab") {
                                                setOpen(false);
                                            }
                                        }}
                                    >
                                        <span>
                                            <strong>{model.name || model.id}</strong>
                                            <small>{model.id}</small>
                                        </span>
                                        {selected ? <Icon name="check" size={14} /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                    {models.length === 0 ? <p>No models are available for this runtime.</p> : null}
                </div>
            </div>
        </div>
    );
}
