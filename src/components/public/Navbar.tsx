"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";

export default function Navbar() {
  const [isOpen, setIsOpen] = useState(false);

  const toggleMenu = () => setIsOpen(!isOpen);

  const navLinks = [
    { name: "Home", href: "/#home" },
    { name: "Achievements", href: "/#achievements" },
    { name: "Schedule", href: "/#schedule" },
    { name: "About Us", href: "/#about" },
    { name: "Contact Us", href: "/#contact" },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-kca-border bg-kca-black/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 md:px-8">
        {/* Logo */}
        <Link href="/#home" className="flex items-center gap-3">
          <Image
            src="/kca-logo.png"
            alt="Kamath Chess Academy Logo"
            width={40}
            height={40}
            className="h-10 w-auto"
            priority
          />
          <span className="font-display text-xl font-bold tracking-tight text-kca-white md:text-2xl">
            KAMATH CHESS ACADEMY
          </span>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.name}
              href={link.href}
              className="font-display text-sm font-medium text-kca-gray-400 transition-colors hover:text-kca-cyan"
            >
              {link.name}
            </Link>
          ))}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden items-center gap-3 md:flex">
          <ThemeToggle variant="icon" />
          <Link href="/login" className="block rounded-lg border border-kca-cyan bg-transparent px-5 py-2 font-display text-sm font-semibold text-kca-cyan transition-all duration-300 hover:bg-kca-cyan/10 hover:shadow-[0_0_15px_rgba(0,200,232,0.2)]">
            Login
          </Link>
        </div>

        {/* Mobile controls */}
        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle variant="icon" />
          <button
            onClick={toggleMenu}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-kca-border text-kca-white transition-colors hover:border-kca-cyan hover:text-kca-cyan"
            aria-label="Toggle navigation menu"
          >
            {isOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Slide-in Menu Overlay */}
      {isOpen && (
        <div className="fixed inset-0 top-[73px] z-40 bg-kca-black/95 backdrop-blur-lg md:hidden">
          <div className="flex h-full flex-col p-8 space-y-6">
            <nav className="flex flex-col space-y-6">
              {navLinks.map((link) => (
                <Link
                  key={link.name}
                  href={link.href}
                  onClick={() => setIsOpen(false)}
                  className="font-display text-lg font-medium text-kca-gray-400 transition-colors hover:text-kca-cyan"
                >
                  {link.name}
                </Link>
              ))}
            </nav>
            <div className="pt-6 border-t border-kca-border">
              <Link href="/login" onClick={() => setIsOpen(false)} className="block w-full rounded-lg border border-kca-cyan bg-transparent py-3 text-center font-display font-semibold text-kca-cyan transition-all duration-300 hover:bg-kca-cyan/10">
                Login
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
