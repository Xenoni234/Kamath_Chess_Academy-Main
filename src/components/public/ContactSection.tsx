"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { MapPin, Mail, Phone, Send, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

// Form validation schema using Zod
const contactSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters." }),
  email: z.string().email({ message: "Please enter a valid email address." }),
  mobile: z.string().min(10, { message: "Mobile number must be at least 10 digits." })
    .max(30, { message: "Mobile number cannot exceed 30 characters." }),
  message: z.string().min(10, { message: "Message must be at least 10 characters." }),
});

type ContactFormValues = z.infer<typeof contactSchema>;

export default function ContactSection() {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      name: "",
      email: "",
      mobile: "",
      message: "",
    },
  });

  const onSubmit = async (data: ContactFormValues) => {
    setStatus("submitting");
    setErrorMessage("");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to submit the form.");
      }

      setStatus("success");
      reset();
    } catch (error) {
      setStatus("error");
      const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
      setErrorMessage(message);
    }
  };

  return (
    <section id="contact" className="bg-[#0D0D0D] py-20 px-6 md:px-8 relative overflow-hidden">
      <div className="mx-auto max-w-7xl relative z-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-20">
          
          {/* Left Column: Get in Touch info */}
          <div className="flex flex-col justify-between">
            <div>
              <h2 className="section-heading">Get in Touch</h2>
              <p className="section-subheading mt-4">
                Have questions about our training programs, platform access, or corporate tournament setups? Leave us a message and our team will get back to you within 24 hours.
              </p>

              {/* Contact Information Details */}
              <div className="mt-10 space-y-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kca-cyan/10 border border-kca-cyan/20">
                    <MapPin className="h-5 w-5 text-kca-cyan" />
                  </div>
                  <div>
                    <h4 className="font-display text-sm font-semibold text-kca-white uppercase tracking-wider">
                      Academy Address
                    </h4>
                    <p className="mt-1 font-sans text-sm text-kca-gray-400">
                      Mumbai, India
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kca-cyan/10 border border-kca-cyan/20">
                    <Mail className="h-5 w-5 text-kca-cyan" />
                  </div>
                  <div>
                    <h4 className="font-display text-sm font-semibold text-kca-white uppercase tracking-wider">
                      Email Address
                    </h4>
                    <p className="mt-1 font-sans text-sm text-kca-gray-400">
                      kamathchessacademy@gmail.com
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kca-cyan/10 border border-kca-cyan/20">
                    <Phone className="h-5 w-5 text-kca-cyan" />
                  </div>
                  <div>
                    <h4 className="font-display text-sm font-semibold text-kca-white uppercase tracking-wider">
                      Phone Number
                    </h4>
                    <p className="mt-1 font-sans text-sm text-kca-gray-400">
                      9175067715 , +91 73874 65229
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kca-cyan/10 border border-kca-cyan/20">
                    <svg
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="2"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5 text-kca-cyan"
                    >
                      <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
                      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
                      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
                    </svg>
                  </div>
                  <div>
                    <h4 className="font-display text-sm font-semibold text-kca-white uppercase tracking-wider">
                      Instagram
                    </h4>
                    <p className="mt-1 font-sans text-sm text-kca-gray-400">
                      <a 
                        href="https://www.instagram.com/kamath_chess/" 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="text-kca-cyan hover:underline transition-all"
                      >
                        kamath_Chess
                      </a>
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Faint cyan design element */}
            <div className="mt-12 hidden lg:block border-l border-kca-border pl-6">
              <p className="font-sans text-xs italic text-kca-gray-600">
                &ldquo;Chess is the gymnasium of the mind.&rdquo; — Blaise Pascal
              </p>
            </div>
          </div>

          {/* Right Column: Contact Form */}
          <div className="bg-kca-black border border-kca-border p-8 rounded-2xl">
            <h3 className="font-display text-xl font-bold text-kca-white mb-6">
              Send a Message
            </h3>

            {status === "success" ? (
              <div className="flex flex-col items-center justify-center text-center py-10">
                <CheckCircle className="h-16 w-16 text-emerald-500 mb-4 animate-bounce" />
                <h4 className="font-display text-lg font-bold text-kca-white">
                  Message Sent Successfully!
                </h4>
                <p className="mt-2 font-sans text-sm text-kca-gray-400 max-w-sm">
                  Thank you for reaching out. We have received your query and will reply shortly.
                </p>
                <button
                  onClick={() => setStatus("idle")}
                  className="mt-6 btn-secondary px-5 py-2 text-sm"
                >
                  Send Another Message
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
                {status === "error" && (
                  <div className="flex items-center gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-red-400">
                    <AlertCircle className="h-5 w-5 flex-shrink-0" />
                    <span className="font-sans text-sm">{errorMessage}</span>
                  </div>
                )}

                {/* Name */}
                <div>
                  <label htmlFor="name" className="block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-2">
                    Name
                  </label>
                  <input
                    type="text"
                    id="name"
                    {...register("name")}
                    className="input-field"
                    placeholder="Grandmaster Garry"
                  />
                  {errors.name && (
                    <p className="mt-1.5 font-sans text-xs text-red-500">{errors.name.message}</p>
                  )}
                </div>

                {/* Email */}
                <div>
                  <label htmlFor="email" className="block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    id="email"
                    {...register("email")}
                    className="input-field"
                    placeholder="garry@chess.com"
                  />
                  {errors.email && (
                    <p className="mt-1.5 font-sans text-xs text-red-500">{errors.email.message}</p>
                  )}
                </div>

                {/* Mobile */}
                <div>
                  <label htmlFor="mobile" className="block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-2">
                    Mobile
                  </label>
                  <input
                    type="tel"
                    id="mobile"
                    {...register("mobile")}
                    className="input-field"
                    placeholder="+91 9876543210"
                  />
                  {errors.mobile && (
                    <p className="mt-1.5 font-sans text-xs text-red-500">{errors.mobile.message}</p>
                  )}
                </div>

                {/* Message */}
                <div>
                  <label htmlFor="message" className="block font-display text-xs font-semibold uppercase tracking-wider text-kca-gray-400 mb-2">
                    Message
                  </label>
                  <textarea
                    id="message"
                    rows={4}
                    {...register("message")}
                    className="input-field resize-none"
                    placeholder="Tell us about your current chess rating, goals, and training requirements..."
                  />
                  {errors.message && (
                    <p className="mt-1.5 font-sans text-xs text-red-500">{errors.message.message}</p>
                  )}
                </div>

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={status === "submitting"}
                  className="w-full btn-primary py-3.5 mt-2 flex items-center justify-center gap-2"
                >
                  {status === "submitting" ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      Send Message
                    </>
                  )}
                </button>
              </form>
            )}
          </div>

        </div>
      </div>
    </section>
  );
}
